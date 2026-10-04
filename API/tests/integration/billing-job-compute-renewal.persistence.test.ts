import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertLiveJobComputeDispatch, issueJobComputeRenewal, recoverJobComputeRenewal,
  renewJobComputeAuthority, revokeJobComputeRenewal,
  revokeJobComputeRenewalFromOrigin,
  type JobComputeIdentity,
} from '../../src/services/billing-job-compute-renewal.service.js';
import { digestBillingAppKey } from '../../src/utils/billing-app-key.js';
import {
  getAccessTokenPublicJwks, resetAccessTokenKeyCache, signConfidentialAccessToken,
} from '../../src/services/oauth/access-token.service.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled = Boolean(process.env.DATABASE_URL);
const secret = `uoa_job_${'a'.repeat(43)}`;
const appKey = `uoa_app_${'b'.repeat(43)}`;
const runtimeSecret = `uoa_ledger_${'d'.repeat(43)}`;
const grantId = 'grant-job-compute-test';
const identity: JobComputeIdentity = {
  originInvocationId: 'inv-job-compute-test',
  ledgerJobId: 'ledger-job-compute-test',
  waterJobId: '12345678-1234-4123-8123-123456789abc',
  scopeTurnId: null,
  purpose: 'research_compute',
};
let db: PrismaClient;
let cleanup: () => Promise<void>;
const originalEnv = {
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK,
};

function freshOriginalDelegation() {
  return signConfidentialAccessToken({
    subject: 'subject-job-test', credentialEpoch: 0, email: 'job@example.com',
    sourceDomain: 'api.nessie.works', product: 'nessie',
    resource: 'https://ledger.unlikeotherai.com',
    issuer: 'https://authentication.unlikeotherai.com', ttlSeconds: 45,
    scope: 'ai.invoke', active: { orgId: 'org-job-test', teamId: 'team-job-test' },
    org: { org_id: 'org-job-test', tenant_slug: 'job-test', org_role: 'owner',
      teams: ['team-job-test'], team_roles: { 'team-job-test': 'owner' } },
  });
}

describe.skipIf(!enabled)('finite job-compute grant in PostgreSQL', () => {
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    const privateJwk = await exportJWK(pair.privateKey);
    Object.assign(privateJwk, { kid: 'job-compute-test', alg: 'RS256', use: 'sig' });
    process.env.PUBLIC_BASE_URL = 'https://authentication.unlikeotherai.com';
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify(privateJwk);
    resetAccessTokenKeyCache();
    const handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL required');
    db = handle.prisma;
    cleanup = handle.cleanup;
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`INSERT INTO billing_services
        (id, identifier, name, updated_at) VALUES
        ('svc-job-origin', 'nessie', 'Nessie', CURRENT_TIMESTAMP),
        ('svc-job-water', 'deepwater', 'Water', CURRENT_TIMESTAMP)`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO users
        (id, email, user_key, name) VALUES
        ('subject-job-test', 'job@example.com', 'job@example.com', 'Job')`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO organisations
        (id, domain, name, slug, owner_id, updated_at) VALUES
        ('org-job-test', 'api.nessie.works', 'Job', 'job-test', 'subject-job-test', CURRENT_TIMESTAMP)`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO teams
        (id, org_id, name, slug, updated_at) VALUES
        ('team-job-test', 'org-job-test', 'Job', 'job-test', CURRENT_TIMESTAMP)`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO org_members
        (id, org_id, user_id, domain, role, updated_at) VALUES
        ('org-member-job', 'org-job-test', 'subject-job-test', 'api.nessie.works', 'owner', CURRENT_TIMESTAMP)`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO team_members
        (id, team_id, user_id, team_role, updated_at) VALUES
        ('team-member-job', 'team-job-test', 'subject-job-test', 'owner', CURRENT_TIMESTAMP)`);
      await tx.domainRole.create({ data: { domain: 'api.nessie.works',
        userId: 'subject-job-test', role: 'USER' } });
      const origin = await tx.clientDomain.create({ data: { domain: 'api.nessie.works',
        label: 'Nessie', status: 'active' } });
      const recipient = await tx.clientDomain.create({ data: { domain: 'api.deepwater.live',
        label: 'Water', status: 'active' } });
      for (const [clientDomainId, product] of [
        [origin.id, 'nessie'], [recipient.id, 'deepwater'],
      ] as const) {
        await tx.confidentialDelegationMapping.create({ data: {
          clientDomainId, product, resource: 'https://ledger.unlikeotherai.com',
          scopes: ['AI_INVOKE'], enabled: true,
        } });
      }
      await tx.billingLedgerRuntimeKey.create({ data: {
        id: 'key-job-origin', serviceId: 'svc-job-origin',
        secretDigest: createHash('sha256').update(runtimeSecret).digest('hex'),
        keyPrefix: runtimeSecret.slice(0, 18), ledgerAudience: 'https://ledger.unlikeotherai.com',
        sourceDomain: 'api.nessie.works', createdByEmail: 'admin@example.com',
      } });
      await tx.billingLedgerRuntimeKey.create({ data: {
        id: 'key-job-water', serviceId: 'svc-job-water',
        secretDigest: createHash('sha256').update('water-runtime').digest('hex'),
        keyPrefix: 'water-runtime', ledgerAudience: 'https://ledger.unlikeotherai.com',
        sourceDomain: 'api.deepwater.live', createdByEmail: 'admin@example.com',
      } });
      await tx.billingAppKey.create({ data: {
        id: 'app-key-job-water', serviceId: 'svc-job-water',
        purpose: 'CUSTOMER_LIFECYCLE', name: 'Water lifecycle',
        keyPrefix: appKey.slice(0, 16), secretDigest: digestBillingAppKey(appKey),
        actorIssuer: 'https://api.deepwater.live',
        actorAudience: 'https://authentication.unlikeotherai.com/billing',
        actorKeyId: 'water-key', actorPublicJwk: {},
        checkoutReturnOrigins: ['https://api.deepwater.live'],
      } });
      await tx.billingJobComputeRenewal.create({ data: {
        id: grantId, issueKey: '1'.repeat(64), identityKey: '2'.repeat(64),
        secretDigest: createHash('sha256').update(secret).digest('hex'),
        originRuntimeKeyId: 'key-job-origin', originProduct: 'nessie',
        originSourceDomain: 'api.nessie.works', identityDomain: 'api.nessie.works',
        subjectId: 'subject-job-test', orgId: 'org-job-test', teamId: 'team-job-test',
        tokenVersion: 7, originTokenJti: 'original-token-job-test',
        originInvocationId: identity.originInvocationId,
        ledgerJobId: identity.ledgerJobId, waterJobId: identity.waterJobId,
        scopeTurnId: null, purpose: identity.purpose,
        recipientOrigin: 'https://api.deepwater.live', recipientProduct: 'deepwater',
        ledgerAudience: 'https://ledger.unlikeotherai.com',
        expiresAt: new Date(Date.now() + 60_000),
      } });
    });
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    resetAccessTokenKeyCache();
    if (cleanup) await cleanup();
  });

  it('issues once from a fresh UOA token and preserves first expiry on lost acknowledgement', async () => {
    const delegation = await freshOriginalDelegation();
    const input = { ...identity, ledgerJobId: 'ledger-job-issue-test',
      issueKey: '3'.repeat(64), secret: `uoa_job_${'c'.repeat(43)}` };
    const first = await issueJobComputeRenewal({ runtimeSecret, delegation, input },
      { prisma: db });
    const replay = await issueJobComputeRenewal({ runtimeSecret, delegation, input },
      { prisma: db });
    expect(replay).toEqual(first);
    expect(await recoverJobComputeRenewal({ runtimeSecret, input }, { prisma: db }))
      .toEqual(first);
    expect(await db.billingJobComputeRenewal.count({ where: { issueKey: input.issueKey } }))
      .toBe(1);
    const row = await db.billingJobComputeRenewal.findUniqueOrThrow({
      where: { issueKey: input.issueKey },
    });
    expect(row.expiresAt.getTime() - row.createdAt.getTime())
      .toBe(7 * 24 * 60 * 60 * 1000);
    expect(JSON.stringify(row)).not.toContain(input.secret);
    await expect(issueJobComputeRenewal({ runtimeSecret, delegation,
      input: { ...input, secret: `uoa_job_${'e'.repeat(43)}` } },
    { prisma: db })).rejects.toThrow('JOB_COMPUTE_ISSUE_CONFLICT');
    await expect(recoverJobComputeRenewal({ runtimeSecret,
      input: { ...input, secret: `uoa_job_${'e'.repeat(43)}` } },
    { prisma: db })).rejects.toThrow('JOB_COMPUTE_RENEWAL_DENIED');
  });

  it('requires exact frozen lineage, then revokes durably and refuses renewal', async () => {
    await expect(revokeJobComputeRenewal({ appKey, secret, grantId,
      identity: { ...identity, ledgerJobId: 'different-job' } }, { prisma: db }))
      .rejects.toThrow('JOB_COMPUTE_RENEWAL_DENIED');
    expect((await db.billingJobComputeRenewal.findUniqueOrThrow({ where: { id: grantId } }))
      .revokedAt).toBeNull();
    await expect(revokeJobComputeRenewal({ appKey, secret: `${secret}z`, grantId,
      identity }, { prisma: db })).rejects.toThrow();
    await expect(revokeJobComputeRenewal({ appKey, secret, grantId,
      identity }, { prisma: db })).resolves.toEqual({ revoked: true });
    const row = await db.billingJobComputeRenewal.findUniqueOrThrow({ where: { id: grantId } });
    expect(row.revokedAt).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(secret);
    await expect(renewJobComputeAuthority({ appKey, secret, grantId, identity },
      { prisma: db })).rejects.toThrow('JOB_COMPUTE_RENEWAL_DENIED');
  });

  it('concurrent identical issue requests converge to one durable grant', async () => {
    const delegation = await freshOriginalDelegation();
    const input = { ...identity, ledgerJobId: 'ledger-job-concurrent-test',
      issueKey: '5'.repeat(64), secret: `uoa_job_${'g'.repeat(43)}` };
    const [first, second] = await Promise.all([
      issueJobComputeRenewal({ runtimeSecret, delegation, input }, { prisma: db }),
      issueJobComputeRenewal({ runtimeSecret, delegation, input }, { prisma: db }),
    ]);
    expect(second).toEqual(first);
    expect(await db.billingJobComputeRenewal.count({ where: { issueKey: input.issueKey } }))
      .toBe(1);
  });

  it('renews a live original grant with frozen epoch and refuses its token after revoke', async () => {
    const row = await db.billingJobComputeRenewal.findUniqueOrThrow({
      where: { issueKey: '3'.repeat(64) },
    });
    const issuedIdentity: JobComputeIdentity = {
      originInvocationId: row.originInvocationId, ledgerJobId: row.ledgerJobId,
      waterJobId: row.waterJobId, scopeTurnId: row.scopeTurnId,
      purpose: row.purpose as JobComputeIdentity['purpose'],
    };
    const issuedSecret = `uoa_job_${'c'.repeat(43)}`;
    const result = await renewJobComputeAuthority({ appKey, secret: issuedSecret,
      grantId: row.id, identity: issuedIdentity }, { prisma: db });
    const verified = await jwtVerify(result.access_token,
      createLocalJWKSet(await getAccessTokenPublicJwks()), {
        issuer: 'https://authentication.unlikeotherai.com',
        audience: 'https://ledger.unlikeotherai.com',
      });
    expect(verified.payload).toMatchObject({ sub: 'subject-job-test', tv: 0,
      source_domain: 'api.deepwater.live', product: 'deepwater',
      job_compute: { grant_id: row.id, origin_invocation_id: row.originInvocationId,
        ledger_job_id: row.ledgerJobId, water_job_id: row.waterJobId } });
    expect(verified.payload.exp! - verified.payload.iat!).toBeLessThanOrEqual(120);
    const dispatch = { claim: verified.payload.job_compute,
      identity: { ...issuedIdentity, grantId: row.id }, runtimeKeyId: 'key-job-water',
      subjectId: row.subjectId, orgId: row.orgId, teamId: row.teamId,
      tokenVersion: row.tokenVersion, now: new Date() };
    await expect(db.$transaction((tx) => assertLiveJobComputeDispatch(tx, dispatch)))
      .resolves.toBeUndefined();
    await db.billingJobComputeRenewal.update({ where: { id: row.id },
      data: { expiresAt: new Date(Date.now() + 25_000) } });
    const nearExpiry = await renewJobComputeAuthority({ appKey, secret: issuedSecret,
      grantId: row.id, identity: issuedIdentity }, { prisma: db });
    expect(nearExpiry.expires_in).toBeGreaterThan(0);
    expect(nearExpiry.expires_in).toBeLessThanOrEqual(25);
    await revokeJobComputeRenewal({ appKey, secret: issuedSecret,
      grantId: row.id, identity: issuedIdentity }, { prisma: db });
    await expect(db.$transaction((tx) => assertLiveJobComputeDispatch(tx, dispatch)))
      .rejects.toThrow('JOB_COMPUTE_DISPATCH_MISMATCH');
  });

  it('refuses a revoked grant at reservation even with a signed, unexpired claim', async () => {
    await expect(db.$transaction((tx) => assertLiveJobComputeDispatch(tx, {
      claim: { grant_id: grantId, origin_invocation_id: identity.originInvocationId,
        ledger_job_id: identity.ledgerJobId, water_job_id: identity.waterJobId,
        scope_turn_id: null, purpose: identity.purpose, origin_product: 'nessie',
        origin_source_domain: 'api.nessie.works' },
      identity: { ...identity, grantId }, runtimeKeyId: 'key-job-origin',
      subjectId: 'subject-job-test', orgId: 'org-job-test', teamId: 'team-job-test',
      tokenVersion: 7, now: new Date(),
    }))).rejects.toThrow('JOB_COMPUTE_DISPATCH_MISMATCH');
  });

  it('refuses recovery when the original login epoch has changed', async () => {
    const input = { ...identity, ledgerJobId: 'ledger-job-epoch-test',
      issueKey: '4'.repeat(64), secret: `uoa_job_${'f'.repeat(43)}` };
    await issueJobComputeRenewal({ runtimeSecret,
      delegation: await freshOriginalDelegation(), input }, { prisma: db });
    await db.user.update({ where: { id: 'subject-job-test' },
      data: { tokenVersion: 1 } });
    await expect(recoverJobComputeRenewal({ runtimeSecret, input },
      { prisma: db })).rejects.toThrow('AUTHENTICATION_FAILED');
    const row = await db.billingJobComputeRenewal.findUniqueOrThrow({
      where: { issueKey: input.issueKey },
    });
    await expect(revokeJobComputeRenewalFromOrigin({ runtimeSecret,
      issueKey: input.issueKey, grantId: row.id,
      identity: { ...identity, ledgerJobId: 'wrong' } },
    { prisma: db })).rejects.toThrow('JOB_COMPUTE_RENEWAL_DENIED');
    await expect(revokeJobComputeRenewalFromOrigin({ runtimeSecret,
      issueKey: 'f'.repeat(64), grantId: row.id,
      identity: { ...identity, ledgerJobId: input.ledgerJobId } },
    { prisma: db })).rejects.toThrow('JOB_COMPUTE_RENEWAL_DENIED');
    await expect(revokeJobComputeRenewalFromOrigin({ runtimeSecret,
      issueKey: input.issueKey, grantId: row.id,
      identity: { ...identity, ledgerJobId: input.ledgerJobId } },
    { prisma: db })).resolves.toEqual({ revoked: true });
    expect((await db.billingJobComputeRenewal.findUniqueOrThrow({
      where: { id: row.id },
    })).revokedAt).not.toBeNull();
  });
});
