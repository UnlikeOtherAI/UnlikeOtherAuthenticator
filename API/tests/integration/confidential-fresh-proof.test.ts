import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApp } from '../../src/app.js';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { asPrismaClient } from '../../src/db/tenant-context.js';
import { hashPassword } from '../../src/services/password.service.js';
import { issueRefreshToken } from '../../src/services/refresh-token.service.js';
import { hashRefreshToken } from '../../src/services/refresh-token-replay.service.js';
import { resolveTokenFamilyAssurance } from '../../src/services/token-assurance.service.js';
import { openEnterpriseSecret } from '../../src/services/enterprise-secret.service.js';
import { createRlsTestDb, type RlsTestDbHandle } from '../helpers/test-db.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { baseClientConfigPayload, createTestConfigFetchHandler, signTestConfigJwt, TEST_SHARED_SECRET } from '../helpers/test-config.js';
import { verifyIssuedAccessToken } from '../helpers/access-token.js';

const tokenBody = z.object({ access_token: z.string(), refresh_token: z.string(),
  assurance_ref: z.string().optional(), assurance_expires_at: z.string().optional() });
const password = 'Independent-password1!';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const challenge = createHash('sha256').update(verifier).digest('base64url');

describe('fresh confidential independent proof before floor enrollment', () => {
  let handle: RlsTestDbHandle; let app: FastifyInstance; let passwordHash: string; let index = 0;
  const saved = Object.fromEntries(['DATABASE_URL', 'DATABASE_ADMIN_URL', 'SHARED_SECRET'].map(key => [key, process.env[key]]));
  beforeAll(async () => {
    const created = await createRlsTestDb();
    if (!created) throw new Error('Real isolated PostgreSQL is required');
    handle = created; process.env.DATABASE_URL = handle.appDatabaseUrl; process.env.DATABASE_ADMIN_URL = handle.adminDatabaseUrl;
    process.env.SHARED_SECRET = TEST_SHARED_SECRET; passwordHash = await hashPassword(password);
    app = await createApp(); await app.ready();
  });
  afterAll(async () => {
    await app?.close(); await disconnectPrisma(); vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
    await handle?.cleanup();
  });
  async function fixture(options: { floor?: 0 | 1; selected?: boolean } = {}) {
    const db = handle.prisma; const domain = `fresh-${randomUUID()}.example.com`;
    const configUrl = `https://${domain}/config`; const redirectUrl = `https://${domain}/callback`;
    const domainHash = await seedDomainSecret(db, domain, TEST_SHARED_SECRET);
    const email = `${randomUUID()}@example.test`;
    const user = await db.user.create({ data: { email, userKey: email, passwordHash } });
    await db.domainRole.create({ data: { domain, userId: user.id, role: 'USER' } });
    if (options.floor !== undefined) await db.enterpriseProductReadiness.create({ data: { clientDomain: domain, minimumAssuranceVersion: options.floor } });
    let scope: { orgId: string; teamId: string } | undefined;
    if (options.selected) {
      const org = await db.organisation.create({ data: { domain, ownerId: user.id, name: 'Selected scope', slug: randomUUID() } });
      const team = await db.team.create({ data: { orgId: org.id, name: 'Selected team', slug: randomUUID(), isDefault: true } });
      await db.orgMember.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } });
      await db.teamMember.create({ data: { teamId: team.id, userId: user.id, teamRole: 'owner' } });
      scope = { orgId: org.id, teamId: team.id };
    }
    const config = await signTestConfigJwt(baseClientConfigPayload({ domain, redirect_urls: [redirectUrl],
      org_features: { enabled: Boolean(scope), user_needs_team: Boolean(scope) },
      login_flow: { email_code_enabled: false, team_selection: 'auto' } }));
    vi.stubGlobal('fetch', await createTestConfigFetchHandler({ [configUrl]: config }));
    const remoteAddress = `198.51.100.${++index}`;
    const token = (payload: object, auth = domainHash) => app.inject({ method: 'POST',
      url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`, remoteAddress,
      headers: { authorization: `Bearer ${auth}` }, payload });
    const login = async () => {
      const query = new URLSearchParams({ config_url: configUrl, redirect_url: redirectUrl,
        code_challenge: challenge, code_challenge_method: 'S256' });
      const response = await app.inject({ method: 'POST', url: `/auth/login?${query}`, remoteAddress,
        payload: { email: user.email, password } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).not.toHaveProperty('assurance_ref');
      return z.object({ code: z.string() }).parse(response.json()).code;
    };
    const exchange = (code: string, codeVerifier = verifier) => token({ code, redirect_url: redirectUrl, code_verifier: codeVerifier });
    const legacy = () => issueRefreshToken({ userId: user.id, domain, clientId: domainHash, configUrl, twoFaCompleted: false },
      { prisma: db, sharedSecret: TEST_SHARED_SECRET });
    return { db, domain, configUrl, redirectUrl, domainHash, user, scope, token, login, exchange, legacy };
  }
  it.each([undefined, 0] as const)('issues real encrypted original proof from final evidence with floor %s', async floor => {
    const f = await fixture({ floor }); const code = await f.login();
    const evidence = await f.db.authenticationEvidence.findFirstOrThrow({ where: { userId: f.user.id } });
    expect(evidence.signatureCompletedAt).not.toBeNull(); expect(evidence.consumedAt).toBeNull();
    const response = await f.exchange(code); expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    const issued = tokenBody.parse(response.json()); expect(issued.assurance_ref).toHaveLength(43);
    const claims = await verifyIssuedAccessToken(issued.access_token);
    expect(claims).toMatchObject({ sub: f.user.id, assurance_version: 1 }); expect(claims).not.toHaveProperty('assurance_ref');
    expect(claims).not.toHaveProperty('org'); expect(claims).not.toHaveProperty('active');
    const proof = await f.db.sessionAssurance.findUniqueOrThrow({ where: { id: String(claims.assurance_id) } });
    const family = await f.db.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashRefreshToken(issued.refresh_token, TEST_SHARED_SECRET) } });
    expect(proof).toMatchObject({ method: 'independent', userId: f.user.id, clientDomain: f.domain, credentialEpoch: 0,
      familyId: family.familyId, orgId: null, teamId: null, observedAt: evidence.observedAt, authenticatedAt: evidence.authenticatedAt });
    expect(proof.expiresAt.toISOString()).toBe(issued.assurance_expires_at);
    expect(family.encryptedAssuranceReference).not.toContain(issued.assurance_ref);
    expect(await openEnterpriseSecret(family.encryptedAssuranceReference ?? '', `assurance:${proof.id}`)).toBe(issued.assurance_ref);
    expect((await f.db.authenticationEvidence.findUniqueOrThrow({ where: { id: evidence.id } })).consumedAt).not.toBeNull();
    const refreshedResponse = await f.token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token });
    expect(refreshedResponse.statusCode, refreshedResponse.body).toBe(200);
    const refreshed = tokenBody.parse(refreshedResponse.json());
    expect(refreshed.assurance_ref).toBe(issued.assurance_ref); expect(refreshed.assurance_expires_at).toBe(issued.assurance_expires_at);
    expect((await verifyIssuedAccessToken(refreshed.access_token)).assurance_id).toBe(proof.id);
    expect(await f.db.sessionAssurance.count({ where: { userId: f.user.id } })).toBe(1);
    expect(await f.db.enterpriseProductReadiness.count({ where: { clientDomain: f.domain } })).toBe(floor === undefined ? 0 : 1);
  });
  it('preserves the exact independently selected organisation and team below the floor', async () => {
    const f = await fixture({ selected: true }); const response = await f.exchange(await f.login());
    expect(response.statusCode, response.body).toBe(200);
    const issued = tokenBody.parse(response.json()); const claims = await verifyIssuedAccessToken(issued.access_token);
    expect(claims.active).toMatchObject(f.scope ?? {});
    expect(await f.db.sessionAssurance.findUniqueOrThrow({ where: { id: String(claims.assurance_id) } })).toMatchObject(f.scope ?? {});
  });
  it('never upgrades a legacy refresh family even after the same person completes a healthy new login', async () => {
    const f = await fixture(); const old = await f.legacy();
    const first = await f.token({ grant_type: 'refresh_token', refresh_token: old.refreshToken });
    expect(first.statusCode, first.body).toBe(200); const legacy = tokenBody.parse(first.json());
    expect(legacy.assurance_ref).toBeUndefined(); expect((await verifyIssuedAccessToken(legacy.access_token)).assurance_id).toBeUndefined();
    const fresh = await f.exchange(await f.login()); expect(fresh.statusCode, fresh.body).toBe(200);
    const healthy = tokenBody.parse(fresh.json()); expect(healthy.assurance_ref).toHaveLength(43);
    const attemptedRebind = await f.token({ grant_type: 'refresh_token', refresh_token: legacy.refresh_token, assurance_ref: healthy.assurance_ref });
    expect(attemptedRebind.statusCode).toBe(400);
    const next = await f.token({ grant_type: 'refresh_token', refresh_token: legacy.refresh_token });
    expect(next.statusCode, next.body).toBe(200); expect(tokenBody.parse(next.json()).assurance_ref).toBeUndefined();
  });
  it('refuses a pre-assurance refresh under floor one without upgrading or consuming it', async () => {
    const f = await fixture({ floor: 1 }); const old = await f.legacy();
    const response = await f.token({ grant_type: 'refresh_token', refresh_token: old.refreshToken });
    expect(response.statusCode, response.body).toBe(401);
    expect(await f.db.refreshToken.findUniqueOrThrow({ where: { id: old.refreshTokenId } })).toMatchObject({ assuranceId: null, revokedAt: null, replacedByTokenId: null });
    expect(await f.db.sessionAssurance.count({ where: { userId: f.user.id } })).toBe(0);
  });
  it('requires the authentic domain bearer, exact PKCE and one-use code', async () => {
    const f = await fixture(); const code = await f.login();
    expect((await f.token({ code, redirect_url: f.redirectUrl, code_verifier: verifier }, 'foreign-domain-hash')).statusCode).toBe(401);
    expect((await f.exchange(code, 'z'.repeat(43))).statusCode).toBe(401);
    const issued = await f.exchange(code); expect(issued.statusCode, issued.body).toBe(200);
    expect((await f.exchange(code)).statusCode).toBe(401);
    expect(await f.db.sessionAssurance.count({ where: { userId: f.user.id } })).toBe(1);
  });
  it.each(['epoch', 'evidence'] as const)('refuses current authorization after %s withdrawal', async reason => {
    const f = await fixture(); const code = await f.login();
    if (reason === 'epoch') await f.db.user.update({ where: { id: f.user.id }, data: { tokenVersion: { increment: 1 } } });
    else await f.db.authenticationEvidence.updateMany({ where: { userId: f.user.id }, data: { revokedAt: new Date() } });
    expect((await f.exchange(code)).statusCode).toBe(401);
    expect(await f.db.refreshToken.count({ where: { userId: f.user.id } })).toBe(0);
    expect(await f.db.sessionAssurance.count({ where: { userId: f.user.id } })).toBe(0);
  });
  it.each(['unfinished', 'expired', 'foreign', 'consumed', 'purpose'] as const)('does not mint proof from %s evidence below the floor', async reason => {
    const f = await fixture(); const family = await f.legacy();
    const evidence = await f.db.authenticationEvidence.create({ data: { userId: f.user.id, clientDomain: reason === 'foreign' ? 'foreign.example.com' : f.domain,
      credentialEpoch: 0, referenceHash: randomBytes(32).toString('hex'), method: 'email_password', provenance: 'independent',
      purpose: reason === 'purpose' ? 'management' : 'authorize', actionBinding: 'negative-fixture',
      observedAt: new Date(Date.now() - 120_000), authenticatedAt: new Date(Date.now() - 120_000),
      signatureCompletedAt: reason === 'unfinished' ? null : new Date(), consumedAt: reason === 'consumed' ? new Date() : null,
      expiresAt: new Date(Date.now() + (reason === 'expired' ? -60_000 : 60_000)) } });
    await expect(f.db.$transaction(tx => resolveTokenFamilyAssurance({ prisma: asPrismaClient(tx), userId: f.user.id,
      domain: f.domain, refreshToken: family.refreshToken, sharedSecret: TEST_SHARED_SECRET, credentialEpoch: 0,
      authenticationEvidenceId: evidence.id }))).rejects.toThrow();
    expect(await f.db.sessionAssurance.count({ where: { userId: f.user.id } })).toBe(0);
    expect((await f.db.refreshToken.findUniqueOrThrow({ where: { id: family.refreshTokenId } })).assuranceId).toBeNull();
  });
  it('fails closed without custody and preserves the one-use code for retry after custody recovers', async () => {
    const f = await fixture(); const code = await f.login(); const provider = process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER;
    try {
      Reflect.deleteProperty(process.env, 'ENTERPRISE_SSO_CUSTODY_PROVIDER');
      expect((await f.exchange(code)).statusCode).toBe(503);
      expect(await f.db.refreshToken.count({ where: { userId: f.user.id } })).toBe(0);
      expect(await f.db.sessionAssurance.count({ where: { userId: f.user.id } })).toBe(0);
      expect((await f.db.authenticationEvidence.findFirstOrThrow({ where: { userId: f.user.id } })).consumedAt).toBeNull();
    } finally { if (provider === undefined) Reflect.deleteProperty(process.env, 'ENTERPRISE_SSO_CUSTODY_PROVIDER'); else process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = provider; }
    const retry = await f.exchange(code); expect(retry.statusCode, retry.body).toBe(200); expect(tokenBody.parse(retry.json()).assurance_ref).toHaveLength(43);
  });
});
