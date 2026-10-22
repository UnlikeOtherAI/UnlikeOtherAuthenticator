import { randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { createApp } from '../../src/app.js';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { baseClientConfigPayload, signTestConfigJwt, createTestConfigFetchHandler, TEST_SHARED_SECRET, TEST_CONFIG_JWKS_URL } from '../helpers/test-config.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { issueSessionAssurance } from '../../src/services/session-assurance.service.js';
import { resolveOriginalAssurance } from '../../src/services/confidential-assurance-validation.service.js';
import { revokeAllRefreshTokensForUser } from '../../src/services/refresh-token-revocation.service.js';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../src/services/jwks-fetch.service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/jwks-fetch.service.js')>(), fetchPartnerJwks: transport.fetch,
}));

describe('confidential original global assurance with PostgreSQL', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  const saved = Object.fromEntries(["DATABASE_URL", "DATABASE_ADMIN_URL", "SHARED_SECRET", "CONFIG_JWKS_URL"].map(key => [key, process.env[key]]));
  beforeAll(async () => {
    const created = await createTestDb(); if (!created) throw new Error('Real PostgreSQL DATABASE_URL is required');
    handle = created; process.env.DATABASE_URL = handle.databaseUrl; process.env.DATABASE_ADMIN_URL = handle.databaseUrl;
    process.env.SHARED_SECRET = TEST_SHARED_SECRET; process.env.CONFIG_JWKS_URL = TEST_CONFIG_JWKS_URL;
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
    await disconnectPrisma(); await handle?.cleanup();
  });
  async function fixture() {
    const db = handle.prisma; const domain = `global-${randomUUID()}.example.com`;
    const domainHash = await seedDomainSecret(db, domain, TEST_SHARED_SECRET);
    // Even a compatibility-floor-zero product must provide the original here.
    await db.enterpriseProductReadiness.create({ data: { clientDomain: domain, minimumAssuranceVersion: 0 } });
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, userKey: randomUUID() } });
    await db.domainRole.create({ data: { domain, userId: user.id, role: 'USER' } });
    const key = await generateKeyPair('RS256'); const jwk = { ...await exportJWK(key.publicKey), kid: 'source', alg: 'RS256', use: 'sig' };
    transport.fetch.mockResolvedValue({ keys: [jwk] });
    const config = validateConfigFields(baseClientConfigPayload({ domain }));
    const configJwt = await new SignJWT({ domain, jwks_url: `https://${domain}/jwks` }).setProtectedHeader({ alg: 'RS256', kid: 'source' }).sign(key.privateKey);
    async function original(scope: { orgId?: string; teamId?: string } = {}) {
      const familyId = randomUUID(); const expiresAt = new Date(Date.now() + 600_000);
      await db.refreshToken.create({ data: { familyId, userId: user.id, domain, clientId: 'source',
        configUrl: `https://${domain}/config`, ...scope, tokenHash: randomUUID(), expiresAt: new Date(expiresAt.getTime() + 1000) } });
      return db.$transaction(tx => issueSessionAssurance({ familyId, userId: user.id, clientDomain: domain,
        credentialEpoch: 0, ...scope, method: 'independent', observedAt: new Date(), authenticatedAt: null,
        mfaSource: 'none', amr: ['pwd'], expiresAt, policyGeneration: 0 }, tx));
    }
    const source = await original();
    async function request(overrides: Record<string, unknown> = {}, reference: string | null = source.reference) {
      const assertion = await new SignJWT({ source_domain: domain, tv: 0,
        ...(reference ? { assurance_ref: reference, assurance_version: 1 } : {}), ...overrides })
        .setProtectedHeader({ alg: 'RS256', kid: 'source' }).setIssuer(domain)
        .setAudience('https://authentication.unlikeotherai.com/org').setSubject(typeof overrides.sub === 'string' ? overrides.sub : user.id)
        .setIssuedAt().setExpirationTime('60s').setJti(randomUUID()).sign(key.privateKey);
      return { headers: { 'x-uoa-subject-assertion': assertion }, config, configJwt, adminDb: db } as FastifyRequest;
    }
    return { db, domain, domainHash, user, source, original, request };
  }
  it('accepts only the exact original null scope and keeps its deadline', async () => {
    const f = await fixture();
    const proof = await resolveOriginalAssurance(await f.request(), { assurance_ref: f.source.reference });
    expect(proof.id).toBe(f.source.assurance.id); expect(proof.orgId).toBeNull(); expect(proof.teamId).toBeNull();
    expect(proof.expiresAt).toEqual(f.source.assurance.expiresAt);
  });
  it('refuses missing proof, a newer same-person proof and an active scope on the global path', async () => {
    const f = await fixture(); const newer = await f.original();
    await expect(resolveOriginalAssurance(await f.request({}, null), { assurance_ref: f.source.reference })).rejects.toThrow();
    await expect(resolveOriginalAssurance(await f.request(), { assurance_ref: newer.reference })).rejects.toThrow('INVALID_SESSION_ASSURANCE');
    await expect(resolveOriginalAssurance(await f.request({ active: { orgId: 'foreign-org', teamId: 'foreign-team' } }),
      { assurance_ref: f.source.reference })).rejects.toThrow();
    await expect(resolveOriginalAssurance(await f.request(), { assurance_ref: f.source.reference, team_id: 'team' })).rejects.toThrow();
  });
  it('refuses foreign client/subject/epoch, withdrawn domain role and global revocation', async () => {
    const f = await fixture();
    for (const override of [{ source_domain: 'other.example' }, { sub: 'another-person' }, { tv: 1 }]) {
      await expect(resolveOriginalAssurance(await f.request(override), { assurance_ref: f.source.reference })).rejects.toThrow();
    }
    await f.db.domainRole.delete({ where: { domain_userId: { domain: f.domain, userId: f.user.id } } });
    await expect(resolveOriginalAssurance(await f.request(), { assurance_ref: f.source.reference })).rejects.toThrow();
    await f.db.domainRole.create({ data: { domain: f.domain, userId: f.user.id, role: 'USER' } });
    await revokeAllRefreshTokensForUser(f.user.id, { prisma: f.db });
    await expect(resolveOriginalAssurance(await f.request(), { assurance_ref: f.source.reference })).rejects.toThrow();
  });

  it('keeps exact selected originals through the actual authenticated HTTP route', async () => {
    const f = await fixture();
    const org = await f.db.organisation.create({ data: { domain: f.domain, ownerId: f.user.id, name: 'HTTP scope', slug: randomUUID() } });
    const team = await f.db.team.create({ data: { orgId: org.id, name: 'HTTP team', slug: randomUUID(), isDefault: true } });
    await f.db.orgMember.create({ data: { orgId: org.id, userId: f.user.id, role: 'owner' } });
    await f.db.teamMember.create({ data: { teamId: team.id, userId: f.user.id, teamRole: 'admin' } });
    const scope = { orgId: org.id, teamId: team.id };
    const a = await f.original(scope); const b = await f.original(scope);
    const configUrl = `https://${f.domain}/config`;
    const config = await signTestConfigJwt(baseClientConfigPayload({ domain: f.domain,
      jwks_url: `https://${f.domain}/.well-known/jwks.json`, org_features: { enabled: true } }));
    vi.stubGlobal('fetch', await createTestConfigFetchHandler({ [configUrl]: config }));
    const app = await createApp(); await app.ready();
    const url = `/org/assurance/validate?domain=${encodeURIComponent(f.domain)}&config_url=${encodeURIComponent(configUrl)}`;
    const credential = await f.request({ active: scope }, a.reference);
    const assertion = credential.headers['x-uoa-subject-assertion'];
    if (typeof assertion !== 'string') throw new Error('Expected a signed assertion');
    const headers = { authorization: `Bearer ${f.domainHash}`, 'x-uoa-subject-assertion': `Bearer ${assertion}` };
    try {
      const match = await app.inject({ method: 'POST', url, headers,
        payload: { assurance_ref: a.reference, org_id: org.id, team_id: team.id } });
      expect(match.statusCode, match.body).toBe(200);
      expect(match.json()).toMatchObject({ active: true, assurance_id: a.assurance.id });
      const swapped = await app.inject({ method: 'POST', url, headers,
        payload: { assurance_ref: b.reference, org_id: org.id, team_id: team.id } });
      expect(swapped.statusCode, swapped.body).toBe(401);
      const globalCredential = await f.request();
      const globalAssertion = globalCredential.headers['x-uoa-subject-assertion'];
      if (typeof globalAssertion !== 'string') throw new Error('Expected global assertion');
      const malformed = await app.inject({ method: 'POST', url,
        headers: { authorization: `Bearer ${f.domainHash}`, 'x-uoa-subject-assertion': globalAssertion },
        payload: { assurance_ref: f.source.reference, team_id: team.id } });
      expect(malformed.statusCode, malformed.body).toBe(400);
      const unauthenticated = await app.inject({ method: 'POST', url,
        headers: { 'x-uoa-subject-assertion': globalAssertion }, payload: { assurance_ref: f.source.reference } });
      expect(unauthenticated.statusCode).toBe(401);
    } finally { await app.close(); vi.unstubAllGlobals(); }
  });
  it('propagates authority outages rather than authenticating from an assertion alone', async () => {
    const f = await fixture(); const request = await f.request();
    const spy = vi.spyOn(f.db.sessionAssurance, 'findUnique').mockRejectedValueOnce(new Error('authority offline'));
    await expect(resolveOriginalAssurance(request, { assurance_ref: f.source.reference })).rejects.toMatchObject({ statusCode: 503 });
    spy.mockRestore();
  });
});
