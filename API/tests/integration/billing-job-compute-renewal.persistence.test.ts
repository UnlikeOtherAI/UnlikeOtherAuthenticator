import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MembershipStatus, Prisma, type PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as prismaProvider from '../../src/db/prisma.js';
import { registerJobComputeRenewalRoutes } from '../../src/routes/billing/job-compute-renewals.js';

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
import { assertActiveSubject } from '../../src/services/billing-prepaid-reservation.service.js';
import { lockAndAssertAuthenticationEpoch } from '../../src/services/authentication-epoch.service.js';
import { lockRefreshSessionUserDomain } from '../../src/services/refresh-session-lock.service.js';
import { lockOrganisationMemberships } from '../../src/services/organisation-membership-lock.service.js';
import { lockTeamMembershipRows } from '../../src/services/team-scope.service.js';

const enabled = Boolean(process.env.DATABASE_URL);
const secret = `uoa_job_${'a'.repeat(43)}`;
const appKey = `uoa_app_${'b'.repeat(43)}`;
const runtimeSecret = `uoa_ledger_${'d'.repeat(43)}`;
const grantId = 'b6b40179-e4e4-4fdd-ad6f-9067f6127110';
const grantUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForEpochLockWaiters(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const rows = await db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS count FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND query LIKE '%pg_advisory_xact_lock(hashtextextended%'
    `);
    if ((rows[0]?.count ?? 0n) >= BigInt(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(`Expected ${expected} transactions to wait on the authentication epoch lock.`);
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
        tokenVersion: 0, originTokenJti: 'original-token-job-test',
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
    expect(first.grant_id).toMatch(grantUuid);
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

  it('renews through HTTP with the exact identifier returned by persisted issuance', async () => {
    const provider = vi.spyOn(prismaProvider, 'getAdminPrisma').mockReturnValue(db);
    const app = Fastify();
    registerJobComputeRenewalRoutes(app);
    const body = { origin_invocation_id: identity.originInvocationId,
      ledger_job_id: 'ledger-job-http-test', water_job_id: identity.waterJobId,
      scope_turn_id: null, purpose: identity.purpose };
    const httpSecret = `uoa_job_${'h'.repeat(43)}`;
    try {
      const issued = await app.inject({ method: 'POST',
        url: '/billing/v1/ledger/job-compute-renewals',
        headers: { authorization: `Bearer ${runtimeSecret}`,
          'x-uoa-delegation': await freshOriginalDelegation() },
        payload: { ...body, issue_key: '6'.repeat(64), secret: httpSecret } });
      expect(issued.statusCode).toBe(200);
      const result = issued.json<{ grant_id: string }>();
      expect(result.grant_id).toMatch(grantUuid);
      const renewed = await app.inject({ method: 'POST',
        url: `/billing/v1/job-compute-renewals/${result.grant_id}/renew`,
        headers: { authorization: `Bearer ${appKey}` },
        payload: { ...body, secret: httpSecret } });
      expect(renewed.statusCode).toBe(200);
      const verified = await jwtVerify(renewed.json<{ access_token: string }>().access_token,
        createLocalJWKSet(await getAccessTokenPublicJwks()));
      expect(verified.payload.job_compute).toMatchObject({ grant_id: result.grant_id,
        ledger_job_id: body.ledger_job_id, water_job_id: body.water_job_id });
    } finally {
      await app.close();
      provider.mockRestore();
    }
  });

  it('keeps concurrent renewal transactions healthy without shared-key telemetry writes', async () => {
    const input = { ...identity, ledgerJobId: 'ledger-job-concurrent-renew-test',
      issueKey: '9'.repeat(64), secret: `uoa_job_${'k'.repeat(43)}` };
    const issued = await issueJobComputeRenewal({ runtimeSecret,
      delegation: await freshOriginalDelegation(), input }, { prisma: db });
    await db.billingAppKey.update({ where: { id: 'app-key-job-water' }, data: { lastUsedAt: null } });
    const renewed = await Promise.all(Array.from({ length: 4 }, () =>
      renewJobComputeAuthority({ appKey, secret: input.secret,
        grantId: issued.grant_id, identity: input }, { prisma: db })));

    expect(renewed).toHaveLength(4);
    expect(renewed.every((result) => result.access_token.length > 0)).toBe(true);
    expect((await db.billingAppKey.findUniqueOrThrow({ where: { id: 'app-key-job-water' } })).lastUsedAt)
      .toBeNull();
  });

  it('serializes renewal and dispatch ahead of membership revocation locks', async () => {
    const input = { ...identity, ledgerJobId: 'ledger-job-revoke-race-test',
      issueKey: 'a'.repeat(64), secret: `uoa_job_${'l'.repeat(43)}` };
    const issued = await issueJobComputeRenewal({ runtimeSecret,
      delegation: await freshOriginalDelegation(), input }, { prisma: db });
    const grant = await db.billingJobComputeRenewal.findUniqueOrThrow({
      where: { id: issued.grant_id },
    });
    const dispatchIdentity = { ...identity, ledgerJobId: input.ledgerJobId,
      grantId: grant.id };
    const claim = { grant_id: grant.id, origin_invocation_id: identity.originInvocationId,
      ledger_job_id: input.ledgerJobId, water_job_id: identity.waterJobId,
      scope_turn_id: null, purpose: identity.purpose, origin_product: 'nessie',
      origin_source_domain: 'api.nessie.works' };
    const revocationLocked = deferred();
    const finishRevocation = deferred();
    const revocation = db.$transaction(async (tx) => {
      await lockRefreshSessionUserDomain({ userId: grant.subjectId,
        domain: grant.identityDomain }, { prisma: tx });
      await lockOrganisationMemberships(tx, grant.orgId, [grant.subjectId]);
      await lockTeamMembershipRows({ userId: grant.subjectId, orgId: grant.orgId,
        teamId: grant.teamId }, { prisma: tx });
      revocationLocked.resolve();
      await finishRevocation.promise;
      await tx.orgMember.update({ where: { orgId_userId: {
        orgId: grant.orgId, userId: grant.subjectId } },
      data: { status: MembershipStatus.DEACTIVATED } });
      await tx.teamMember.update({ where: { id: 'team-member-job' },
        data: { status: MembershipStatus.DEACTIVATED } });
    }, { timeout: 10_000 });
    await revocationLocked.promise;

    const renewalResult = renewJobComputeAuthority({ appKey, secret: input.secret,
      grantId: grant.id, identity: input }, { prisma: db }).then(
      () => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
    const dispatchResult = db.$transaction(async (tx) => {
      // This is the same authority order used by reservePrepaidDispatch.
      await lockAndAssertAuthenticationEpoch({ userId: grant.subjectId,
        domain: grant.identityDomain, credentialEpoch: grant.tokenVersion }, { prisma: tx });
      await assertActiveSubject(tx, { userId: grant.subjectId, organisationId: grant.orgId,
        teamId: grant.teamId }, grant.tokenVersion);
      await assertLiveJobComputeDispatch(tx, { claim, identity: dispatchIdentity,
        runtimeKeyId: 'key-job-water', subjectId: grant.subjectId, orgId: grant.orgId,
        teamId: grant.teamId, tokenVersion: grant.tokenVersion,
        identityDomain: grant.identityDomain, now: new Date() });
    }, { timeout: 10_000 }).then(
      () => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));

    try {
      await waitForEpochLockWaiters(2);
      finishRevocation.resolve();
      await revocation;
      const [renewal, dispatch] = await Promise.all([renewalResult, dispatchResult]);
      expect(renewal.ok).toBe(false);
      expect(dispatch.ok).toBe(false);
    } finally {
      finishRevocation.resolve();
      await revocation.catch(() => undefined);
      await db.orgMember.update({ where: { orgId_userId: {
        orgId: grant.orgId, userId: grant.subjectId } },
      data: { status: MembershipStatus.ACTIVE } });
      await db.teamMember.update({ where: { id: 'team-member-job' },
        data: { status: MembershipStatus.ACTIVE } });
    }
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
    await db.billingAppKey.update({ where: { id: 'app-key-job-water' }, data: { lastUsedAt: null } });
    const result = await renewJobComputeAuthority({ appKey, secret: issuedSecret,
      grantId: row.id, identity: issuedIdentity }, { prisma: db });
    expect((await db.billingAppKey.findUniqueOrThrow({ where: { id: 'app-key-job-water' } })).lastUsedAt)
      .toBeNull();
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
      tokenVersion: row.tokenVersion, identityDomain: row.identityDomain, now: new Date() };
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
      tokenVersion: 0, identityDomain: 'api.nessie.works', now: new Date(),
    }))).rejects.toThrow('JOB_COMPUTE_DISPATCH_MISMATCH');
  });

  it('recovers migrated identifiers without changing authority or valid identifiers', async () => {
    const original = await db.billingJobComputeRenewal.findUniqueOrThrow({ where: { id: grantId } });
    const input = { ...identity, ledgerJobId: 'ledger-job-migration-test',
      issueKey: '8'.repeat(64), secret: `uoa_job_${'j'.repeat(43)}` };
    await issueJobComputeRenewal({ runtimeSecret,
      delegation: await freshOriginalDelegation(), input }, { prisma: db });
    const before = await db.billingJobComputeRenewal.findUniqueOrThrow({ where: { issueKey: input.issueKey } });
    const legacyId = 'cmlegacygrant0000000000000';
    const migration = readFileSync(new URL(
      '../../prisma/migrations/20261007103000_job_compute_grant_uuid/migration.sql',
      import.meta.url), 'utf8');
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE billing_job_compute_renewals DROP CONSTRAINT billing_job_compute_grant_id_uuid');
      await tx.billingJobComputeRenewal.update({ where: { id: before.id }, data: { id: legacyId } });
      await tx.$executeRawUnsafe(migration);
    });
    const migrated = await db.billingJobComputeRenewal.findUniqueOrThrow({ where: { issueKey: input.issueKey } });
    expect(migrated.id).toMatch(grantUuid);
    expect({ ...migrated, id: before.id }).toEqual(before);
    expect(await recoverJobComputeRenewal({ runtimeSecret, input }, { prisma: db }))
      .toMatchObject({ grant_id: migrated.id, expires_at: before.expiresAt.toISOString() });
    expect(await db.billingJobComputeRenewal.findUnique({ where: { id: original.id } })).toEqual(original);
    await expect(db.billingJobComputeRenewal.update({ where: { id: migrated.id },
      data: { id: legacyId } })).rejects.toThrow(/constraint/i);
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
