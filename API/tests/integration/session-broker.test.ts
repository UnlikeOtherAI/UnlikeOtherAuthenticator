import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { signConfidentialAccessToken, resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import * as epoch from '../../src/services/authentication-epoch.service.js';
import { validateSessionBroker } from '../../src/services/session-broker.service.js';
import { createConfidentialDelegationMapping } from '../../src/services/confidential-delegation.service.js';
import { ConfidentialDelegationScope } from '@prisma/client';

const source = 'coder.unlikeotherai.com';
const resource = 'https://api.selkie.live';
const issuer = 'https://authentication.unlikeotherai.com';
describe.skipIf(!process.env.DATABASE_URL)('durable Selkie broker validation', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let userId: string; let orgId: string; let teamId: string; let mappingId: string;
  const saved = { PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK };
  beforeAll(async () => {
    const handle = await createTestDb(); if (!handle) throw new Error('Database required'); db = handle;
    process.env.PUBLIC_BASE_URL = issuer;
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify({ ...await exportJWK(privateKey), kid: 'broker-test' });
    resetAccessTokenKeyCache();
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
    resetAccessTokenKeyCache(); await db?.cleanup();
  });
  beforeEach(async () => {
    await db.prisma.teamMember.deleteMany(); await db.prisma.orgMember.deleteMany();
    await db.prisma.team.deleteMany(); await db.prisma.organisation.deleteMany();
    await db.prisma.domainRole.deleteMany(); await db.prisma.user.deleteMany();
    await db.prisma.confidentialDelegationMapping.deleteMany(); await db.prisma.billingAppKey.deleteMany(); await db.prisma.billingService.deleteMany(); await db.prisma.clientDomain.deleteMany();
    const user = await db.prisma.user.create({ data: { email: `${randomUUID()}@example.com`, userKey: randomUUID() } }); userId = user.id;
    const client = await db.prisma.clientDomain.create({ data: { domain: source, label: 'Coder', status: 'active' } });
    await db.prisma.clientDomain.create({ data: { domain: 'api.selkie.live', label: 'Selkie', status: 'active' } });
    const service = await db.prisma.billingService.create({ data: { identifier: 'selkie', name: 'Selkie' } });
    await db.prisma.billingAppKey.create({ data: { serviceId: service.id, purpose: 'CUSTOMER_LIFECYCLE',
      name: 'Selkie lifecycle', keyPrefix: randomUUID().slice(0, 12), secretDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      actorIssuer: resource, actorAudience: `${issuer}/billing/v1/effective-tariff`, actorKeyId: 'test',
      actorPublicJwk: {}, checkoutReturnOrigins: [resource] } });
    await db.prisma.domainRole.create({ data: { domain: 'api.selkie.live', userId, role: 'USER' } });
    const org = await db.prisma.organisation.create({ data: { domain: source, ownerId: user.id, name: 'Test', slug: randomUUID() } }); orgId = org.id;
    await db.prisma.orgMember.create({ data: { orgId, userId, role: 'owner' } });
    const team = await db.prisma.team.create({ data: { orgId, name: 'Test', slug: randomUUID() } }); teamId = team.id;
    await db.prisma.teamMember.create({ data: { teamId, userId, teamRole: 'owner' } });
    await db.prisma.domainRole.create({ data: { domain: source, userId, role: 'USER' } });
    mappingId = (await db.prisma.confidentialDelegationMapping.create({ data: { clientDomainId: client.id,
      product: 'coder', resource, scopes: [ConfidentialDelegationScope.SESSION_BROKER] } })).id;
  });
  async function token(overrides = {}) {
    return signConfidentialAccessToken({ subject: userId, credentialEpoch: 0, email: 'test@example.com',
      sourceDomain: source, product: 'coder', resource, issuer, ttlSeconds: 300, scope: 'session:broker',
      active: { orgId, teamId }, org: { org_id: orgId, tenant_slug: 'test', org_role: 'owner',
        teams: [teamId], team_roles: { [teamId]: 'owner' } }, ...overrides });
  }
  const validate = (value: string, targetDomain = 'api.selkie.live') => validateSessionBroker({ token: value, targetDomain }, { prisma: db.prisma });
  it('returns only subject, exact active bindings and bounded expiry', async () => {
    const result = await validate(await token());
    expect(Object.keys(result).sort()).toEqual(['active', 'expires_at', 'sub']);
    expect(result.sub).toBe(userId); expect(result.active).toEqual({ orgId, teamId });
    expect(Date.parse(result.expires_at) - Date.now()).toBeLessThanOrEqual(300_000);
  });
  it('rejects a wrong confidential target, audience, source, scope, actor chain and tampered signature', async () => {
    await expect(validate(await token(), 'other.example')).rejects.toThrow();
    for (const overrides of [{ resource: 'https://evil.example' }, { sourceDomain: 'evil.example' },
      { scope: 'token.provision' }, { actor: { sub: source, product: 'coder' } }]) {
      await expect(validate(await token(overrides))).rejects.toThrow();
    }
    const value = await token(); await expect(validate(`${value.slice(0, -5)}AAAAA`)).rejects.toThrow();
  });
  it('rejects expiry and credential epoch changes immediately', async () => {
    await expect(validate(await token({ expiresAtEpochSeconds: Math.floor(Date.now() / 1000) - 1 }))).rejects.toThrow();
    const value = await token(); await db.prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
    await expect(validate(value)).rejects.toThrow();
  });
  it('rejects removed team/domain membership and disabled mapping', async () => {
    const value = await token();
    await db.prisma.teamMember.deleteMany(); await expect(validate(value)).rejects.toThrow();
    await db.prisma.teamMember.create({ data: { teamId, userId, teamRole: 'owner' } });
    await db.prisma.confidentialDelegationMapping.update({ where: { id: mappingId }, data: { enabled: false } });
    await expect(validate(value)).rejects.toThrow();
    await db.prisma.confidentialDelegationMapping.update({ where: { id: mappingId }, data: { enabled: true } });
    await db.prisma.domainRole.deleteMany(); await expect(validate(value)).rejects.toThrow();
  });
  it('refuses operator mappings that widen the broker source, product, resource or scopes', async () => {
    for (const override of [{ sourceDomain: 'other.example' }, { product: 'other' },
      { resource: 'https://other.example' }, { scopes: ['session:broker', 'token.provision'] }]) {
      await expect(createConfidentialDelegationMapping({ sourceDomain: source, product: 'coder', resource,
        scopes: ['session:broker'], actor: { email: 'operator@example.com' }, ...override }, { prisma: db.prisma })).rejects.toThrow();
    }
  });
  it('preserves retryable database failure rather than claiming revocation', async () => {
    const value = await token(); const unavailable = new Error('Database unavailable');
    const spy = vi.spyOn(epoch, 'lockAndAssertAuthenticationEpoch').mockRejectedValueOnce(unavailable);
    try { await expect(validate(value)).rejects.toBe(unavailable); } finally { spy.mockRestore(); }
  });
  it('requires current target product admission and registered cross-product team policy', async () => {
    const value = await token();
    await db.prisma.domainRole.deleteMany({ where: { domain: 'api.selkie.live' } });
    await expect(validate(value)).rejects.toThrow();
    await db.prisma.domainRole.create({ data: { domain: 'api.selkie.live', userId, role: 'USER' } });
    await db.prisma.billingAppKey.updateMany({ data: { revokedAt: new Date() } });
    await expect(validate(value)).rejects.toThrow();
  });
});
