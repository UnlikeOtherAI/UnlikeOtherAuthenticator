import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { issueRefreshToken } from '../../src/services/refresh-token.service.js';
import { issueSessionAssurance } from '../../src/services/session-assurance.service.js';
import {
  claimDeviceLogin, claimDeviceStatus, completeDeviceLogin, consumeDeviceClaimBudget,
  decideDeviceLogin, issueDeviceLogin, sourceDeviceStatus,
} from '../../src/services/device-login.service.js';

const secret = 'device-login-test-secret-with-enough-length';
const domain = 'device-login.example';
const configUrl = 'https://device-login.example/config';
const config = validateConfigFields(baseClientConfigPayload({ domain,
  redirect_urls: ['https://device-login.example/callback'], org_features: { enabled: false },
  login_flow: { email_code_enabled: false, team_selection: 'off' } }));
const challenge = (value: string) => createHash('sha256').update(value).digest('base64url');

describe.skipIf(!process.env.DATABASE_URL)('numeric device login', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let clientDomainId: string;
  const saved = Object.fromEntries(['DATABASE_URL', 'DATABASE_ADMIN_URL', 'SHARED_SECRET',
    'ENTERPRISE_SSO_CUSTODY_PROVIDER', 'ENTERPRISE_SSO_KEYRING'].map(key => [key, process.env[key]]));
  beforeAll(async () => {
    const db = await createTestDb();
    if (!db) throw new Error('Database required');
    handle = db;
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.DATABASE_ADMIN_URL = db.databaseUrl;
    process.env.SHARED_SECRET = secret;
    process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = 'local';
    process.env.ENTERPRISE_SSO_KEYRING = JSON.stringify({ current: 'test', keys: {
      test: randomBytes(32).toString('base64'),
    } });
    clientDomainId = (await handle.prisma.clientDomain.create({ data: {
      domain, label: domain, status: 'active',
    } })).id;
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
    await handle?.cleanup();
  });
  const context = () => ({ config, configUrl, clientId: 'device-client', clientDomainId });
  const deps = () => ({ prisma: handle.prisma });
  async function source() {
    const user = await handle.prisma.user.create({ data: {
      email: randomUUID() + '@example.com', userKey: randomUUID(),
    } });
    const familyId = randomUUID();
    const refresh = await issueRefreshToken({ familyId, userId: user.id, domain, configUrl,
      clientId: 'device-client', twoFaCompleted: true }, { prisma: handle.prisma, sharedSecret: secret });
    const assurance = await issueSessionAssurance({ familyId, userId: user.id, clientDomain: domain,
      credentialEpoch: 0, orgId: null, teamId: null, method: 'independent',
      observedAt: new Date(), authenticatedAt: new Date(), mfaSource: 'none', amr: ['pwd'],
      expiresAt: new Date(Date.now() + 120_000),
    }, handle.prisma);
    await handle.prisma.refreshToken.update({ where: { id: refresh.refreshTokenId },
      data: { assuranceId: assurance.assurance.id } });
    return { user, refresh };
  }
  async function enable() {
    await handle.prisma.clientDomain.update({ where: { id: clientDomainId },
      data: { deviceLoginConfigUrls: [configUrl] } });
  }
  it('is off by default and binds the exact signed site', async () => {
    const a = await source();
    await expect(issueDeviceLogin(context(), a.refresh.refreshToken, undefined, deps())).rejects.toThrow();
    await enable();
    const issued = await issueDeviceLogin(context(), a.refresh.refreshToken, undefined, deps());
    expect(issued.code).toMatch(/^\d{8}$/);
    expect(issued.expires_in).toBeGreaterThan(0);
    expect(issued.expires_in).toBeLessThanOrEqual(300);
    const stored = await handle.prisma.deviceLoginGrant.findUniqueOrThrow({ where: { id: issued.grant_id } });
    expect(stored.codeHash).not.toBe(issued.code);
    expect(stored.challenge).toBeNull();
    await expect(claimDeviceLogin({ ...context(), configUrl: configUrl + '?variant=other' },
      issued.code, challenge('a'.repeat(43)), deps())).rejects.toThrow();
    await handle.prisma.clientDomain.update({ where: { id: clientDomainId },
      data: { deviceLoginConfigUrls: [] } });
    await expect(claimDeviceLogin(context(), issued.code, challenge('a'.repeat(43)), deps())).rejects.toThrow();
  });
  it('requires browser approval, source authority, verifier and a single atomic completion', async () => {
    await enable();
    const a = await source();
    const issued = await issueDeviceLogin(context(), a.refresh.refreshToken, undefined, deps());
    const verifier = 'a'.repeat(43);
    const claim = await claimDeviceLogin(context(), issued.code, challenge(verifier), deps());
    expect(claim.confirmation_code).toMatch(/^\d{4}$/);
    expect((await sourceDeviceStatus(context(), a.refresh.refreshToken, issued.grant_id, deps())).claim_id)
      .toBe(claim.claim_id);
    await expect(completeDeviceLogin(context(), claim.claim_id, verifier, deps())).rejects.toThrow();
    await expect(claimDeviceStatus(context(), claim.claim_id, 'b'.repeat(43), deps())).rejects.toThrow();
    await expect(decideDeviceLogin(context(), a.refresh.refreshToken, issued.grant_id,
      'wrong-claim', true, deps())).rejects.toThrow();
    await decideDeviceLogin(context(), a.refresh.refreshToken, issued.grant_id, claim.claim_id, true, deps());
    const results = await Promise.allSettled([1, 2].map(() =>
      completeDeviceLogin(context(), claim.claim_id, verifier, deps())));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await expect(completeDeviceLogin(context(), claim.claim_id, verifier, deps())).rejects.toThrow();
  });
  it('lets a rightful receiver replace an expired unapproved claim without changing approval binding', async () => {
    await enable();
    const a = await source();
    const issued = await issueDeviceLogin(context(), a.refresh.refreshToken, undefined, deps());
    const attacker = await claimDeviceLogin(context(), issued.code, challenge('a'.repeat(43)), deps());
    const later = { ...deps(), now: () => new Date(Date.now() + 31_000) };
    const results = await Promise.allSettled([1, 2].map((i) =>
      claimDeviceLogin(context(), issued.code, challenge(String(i).repeat(43)), later)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find((result) => result.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('Expected replacement');
    expect(winner.value.claim_id).not.toBe(attacker.claim_id);
    await expect(claimDeviceStatus(context(), attacker.claim_id, 'a'.repeat(43), later)).rejects.toThrow();
    await expect(decideDeviceLogin(context(), a.refresh.refreshToken, issued.grant_id,
      attacker.claim_id, true, later)).rejects.toThrow();
    const status = await sourceDeviceStatus(context(), a.refresh.refreshToken, issued.grant_id, later);
    expect(status.claim_id).toBe(winner.value.claim_id);
    await decideDeviceLogin(context(), a.refresh.refreshToken, issued.grant_id, winner.value.claim_id, false, later);
    const rightful = await claimDeviceLogin(context(), issued.code, challenge('z'.repeat(43)), later);
    expect(rightful.claim_id).not.toBe(winner.value.claim_id);
  });
  it('honors source family revocation, policy disable and expiry at completion', async () => {
    await enable();
    const a = await source();
    const issued = await issueDeviceLogin(context(), a.refresh.refreshToken, undefined, deps());
    const verifier = 'c'.repeat(43);
    const claim = await claimDeviceLogin(context(), issued.code, challenge(verifier), deps());
    await decideDeviceLogin(context(), a.refresh.refreshToken, issued.grant_id, claim.claim_id, true, deps());
    await handle.prisma.refreshToken.updateMany({ where: { userId: a.user.id },
      data: { revokedAt: new Date() } });
    await expect(completeDeviceLogin(context(), claim.claim_id, verifier, deps())).rejects.toThrow();
    const b = await source();
    const second = await issueDeviceLogin(context(), b.refresh.refreshToken, undefined, deps());
    const secondClaim = await claimDeviceLogin(context(), second.code, challenge(verifier), deps());
    await decideDeviceLogin(context(), b.refresh.refreshToken, second.grant_id, secondClaim.claim_id, true, deps());
    await handle.prisma.clientDomain.update({ where: { id: clientDomainId },
      data: { deviceLoginConfigUrls: [] } });
    await expect(completeDeviceLogin(context(), secondClaim.claim_id, verifier, deps())).rejects.toThrow();
    await enable();
    await expect(completeDeviceLogin(context(), secondClaim.claim_id, verifier, {
      ...deps(), now: () => new Date(Date.now() + 300_001),
    })).rejects.toThrow();
  });
  it('shares fail-closed per-site and per-requester guess budgets in durable rows', async () => {
    await enable();
    for (let i = 0; i < 8; i++) {
      await consumeDeviceClaimBudget(context(), '192.0.2.10', deps());
    }
    await expect(consumeDeviceClaimBudget(context(), '192.0.2.10', deps())).rejects.toThrow();
    await expect(consumeDeviceClaimBudget(context(), '192.0.2.11', deps())).resolves.toBeUndefined();
    const buckets = await handle.prisma.deviceLoginAttemptBucket.findMany();
    expect(buckets.some(bucket => bucket.count > 8)).toBe(true);
    expect(buckets.every(bucket => !bucket.keyHash.includes('192.0.2.'))).toBe(true);
  });
  it('keeps pairing authority outside the ordinary tenant database role', async () => {
    const schema = handle.schema;
    const tables = ['device_login_grants', 'device_login_attempt_buckets'];
    for (const table of tables) {
      const [boundary] = await handle.prisma.$queryRawUnsafe<Array<{
        relrowsecurity: boolean; relforcerowsecurity: boolean; tenant_can_select: boolean;
      }>>(`SELECT c.relrowsecurity, c.relforcerowsecurity,
        has_table_privilege('uoa_app', c.oid, 'SELECT') AS tenant_can_select
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`, schema, table);
      expect(boundary).toEqual({
        relrowsecurity: true, relforcerowsecurity: true, tenant_can_select: false,
      });
    }
    // Grant DML deliberately, as createRlsTestDb does, to prove row security also
    // denies authority if a future generic grant accidentally reaches these tables.
    await handle.prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO uoa_app`);
    for (const table of tables) {
      await handle.prisma.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}"."${table}" TO uoa_app`,
      );
      expect(await handle.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE uoa_app');
        const [row] = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT count(*) FROM "${schema}"."${table}"`,
        );
        return row.count;
      })).toBe(0n);
    }
    await expect(handle.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE uoa_app');
      await tx.deviceLoginAttemptBucket.create({ data: {
        keyHash: 'f'.repeat(64), count: 1, resetAt: new Date(Date.now() + 300_000),
      } });
    })).rejects.toThrow();
  });
});
