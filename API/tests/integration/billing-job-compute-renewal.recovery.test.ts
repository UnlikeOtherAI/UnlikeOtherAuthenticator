import { readFileSync } from 'node:fs';
import { MembershipStatus, Prisma } from '@prisma/client';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reservePrepaidDispatch } from '../../src/services/billing-prepaid-reservation.service.js';
import { lockRefreshSessionUserDomain } from '../../src/services/refresh-session-lock.service.js';
import { lockAndAssertAuthenticationEpochShared } from '../../src/services/authentication-epoch.service.js';
import { lockOrganisationMemberships } from '../../src/services/organisation-membership-lock.service.js';
import { lockTeamMembershipRows } from '../../src/services/team-scope.service.js';
import {
  assertLiveJobComputeDispatch,
  issueJobComputeRenewal,
  recoverJobComputeRenewal,
  renewJobComputeAuthority,
  revokeJobComputeRenewal,
  revokeJobComputeRenewalFromOrigin,
  type JobComputeIdentity,
} from '../../src/services/billing-job-compute-renewal.service.js';
import { getAccessTokenPublicJwks } from '../../src/services/oauth/access-token.service.js';
import {
  appKey,
  runtimeSecret,
  waterRuntimeSecret,
  grantId,
  grantUuid,
  identity,
  freshOriginalDelegation,
  deferred,
  waitForEpochLockWaiters,
  setupJobComputeFixture,
  teardownJobComputeFixture,
  enabled,
  db,
} from './helpers/billing-job-compute-renewal-fixture.js';

describe.skipIf(!enabled)('finite job-compute recovery and revocation in PostgreSQL', () => {
  beforeAll(setupJobComputeFixture);
  afterAll(teardownJobComputeFixture);
  it('keeps concurrent renewal transactions healthy without shared-key telemetry writes', async () => {
    const input = {
      ...identity,
      ledgerJobId: 'ledger-job-concurrent-renew-test',
      issueKey: '9'.repeat(64),
      secret: `uoa_job_${'k'.repeat(43)}`,
    };
    const issued = await issueJobComputeRenewal(
      { runtimeSecret, delegation: await freshOriginalDelegation(), input },
      { prisma: db },
    );
    await db.billingAppKey.update({
      where: { id: 'app-key-job-water' },
      data: { lastUsedAt: null },
    });
    const renewed = await Promise.all(
      Array.from({ length: 4 }, () =>
        renewJobComputeAuthority(
          { appKey, secret: input.secret, grantId: issued.grant_id, identity: input },
          { prisma: db },
        ),
      ),
    );

    expect(renewed).toHaveLength(4);
    expect(renewed.every((result) => result.access_token.length > 0)).toBe(true);
    expect(
      (await db.billingAppKey.findUniqueOrThrow({ where: { id: 'app-key-job-water' } })).lastUsedAt,
    ).toBeNull();
  });

  it('lets renewal reads share the epoch while revocation waits and then takes effect', async () => {
    const input = {
      ...identity,
      ledgerJobId: 'ledger-job-shared-epoch-test',
      issueKey: 'b'.repeat(64),
      secret: `uoa_job_${'m'.repeat(43)}`,
    };
    const issued = await issueJobComputeRenewal(
      { runtimeSecret, delegation: await freshOriginalDelegation(), input },
      { prisma: db },
    );
    const readerEntered = deferred();
    const releaseReader = deferred();
    const heldReader = db.$transaction(
      async (tx) => {
        await lockAndAssertAuthenticationEpochShared(
          { userId: 'subject-job-test', domain: 'api.nessie.works', credentialEpoch: 0 },
          {
            prisma: tx,
            afterLock: async () => {
              readerEntered.resolve();
              await releaseReader.promise;
            },
          },
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 },
    );
    await readerEntered.promise;

    const renewalRequests = Promise.all(
      Array.from({ length: 6 }, () =>
        renewJobComputeAuthority(
          { appKey, secret: input.secret, grantId: issued.grant_id, identity: input },
          { prisma: db },
        ),
      ),
    );
    const renewed = await Promise.race([
      renewalRequests,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Concurrent renewal readers did not overlap.')), 4_000),
      ),
    ]);
    expect(renewed).toHaveLength(6);

    const writerEntered = deferred();
    const revocation = db.$transaction(
      async (tx) => {
        await lockRefreshSessionUserDomain(
          { userId: 'subject-job-test', domain: 'api.nessie.works' },
          { prisma: tx },
        );
        writerEntered.resolve();
        await tx.user.update({
          where: { id: 'subject-job-test' },
          data: { tokenVersion: { increment: 1 } },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 },
    );

    try {
      await waitForEpochLockWaiters(1);
      expect(
        await Promise.race([
          writerEntered.promise.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 75)),
        ]),
      ).toBe(false);
    } finally {
      releaseReader.resolve();
    }
    await Promise.all([heldReader, revocation]);
    try {
      await expect(
        renewJobComputeAuthority(
          { appKey, secret: input.secret, grantId: issued.grant_id, identity: input },
          { prisma: db },
        ),
      ).rejects.toThrow('AUTHENTICATION_FAILED');
    } finally {
      await db.user.update({ where: { id: 'subject-job-test' }, data: { tokenVersion: 0 } });
    }
  });

  it('serializes renewal and dispatch ahead of membership revocation locks', async () => {
    const input = {
      ...identity,
      ledgerJobId: 'ledger-job-revoke-race-test',
      issueKey: 'a'.repeat(64),
      secret: `uoa_job_${'l'.repeat(43)}`,
    };
    const issued = await issueJobComputeRenewal(
      { runtimeSecret, delegation: await freshOriginalDelegation(), input },
      { prisma: db },
    );
    const grant = await db.billingJobComputeRenewal.findUniqueOrThrow({
      where: { id: issued.grant_id },
    });
    const dispatchIdentity = { ...identity, ledgerJobId: input.ledgerJobId, grantId: grant.id };
    const activeToken = await renewJobComputeAuthority(
      { appKey, secret: input.secret, grantId: grant.id, identity: input },
      { prisma: db },
    );
    const revocationLocked = deferred();
    const finishRevocation = deferred();
    const revocation = db.$transaction(
      async (tx) => {
        await lockRefreshSessionUserDomain(
          { userId: grant.subjectId, domain: grant.identityDomain },
          { prisma: tx },
        );
        await lockOrganisationMemberships(tx, grant.orgId, [grant.subjectId]);
        await lockTeamMembershipRows(
          { userId: grant.subjectId, orgId: grant.orgId, teamId: grant.teamId },
          { prisma: tx },
        );
        revocationLocked.resolve();
        await finishRevocation.promise;
        await tx.orgMember.update({
          where: {
            orgId_userId: {
              orgId: grant.orgId,
              userId: grant.subjectId,
            },
          },
          data: { status: MembershipStatus.DEACTIVATED },
        });
        await tx.teamMember.update({
          where: { id: 'team-member-job' },
          data: { status: MembershipStatus.DEACTIVATED },
        });
      },
      { timeout: 10_000 },
    );
    await revocationLocked.promise;

    const renewalResult = renewJobComputeAuthority(
      { appKey, secret: input.secret, grantId: grant.id, identity: input },
      { prisma: db },
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const startedAt = new Date().toISOString();
    const dispatchInput = {
      dispatchId: 'dispatch-renewal-membership-race',
      requestFingerprint: 'c'.repeat(64),
      dispatchStartedAt: startedAt,
      product: 'deepwater',
      providerServiceId: 'openrouter',
      organisationId: grant.orgId,
      teamId: grant.teamId,
      userId: grant.subjectId,
      rawCostBound: '1',
      currency: 'USD',
      jobCompute: dispatchIdentity,
      billingContext: {
        contextId: input.originInvocationId,
        originProduct: 'nessie',
        originSourceDomain: 'api.nessie.works',
        projectId: null,
        runId: null,
      },
    };
    const dispatchResult = reservePrepaidDispatch(
      {
        runtimeSecret: waterRuntimeSecret,
        delegation: activeToken.access_token,
        input: dispatchInput,
      },
      { prisma: db },
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

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
      await db.orgMember.update({
        where: {
          orgId_userId: {
            orgId: grant.orgId,
            userId: grant.subjectId,
          },
        },
        data: { status: MembershipStatus.ACTIVE },
      });
      await db.teamMember.update({
        where: { id: 'team-member-job' },
        data: { status: MembershipStatus.ACTIVE },
      });
    }
  });

  it('renews a live original grant with frozen epoch and refuses its token after revoke', async () => {
    const row = await db.billingJobComputeRenewal.findUniqueOrThrow({
      where: { issueKey: '3'.repeat(64) },
    });
    const issuedIdentity: JobComputeIdentity = {
      originInvocationId: row.originInvocationId,
      ledgerJobId: row.ledgerJobId,
      waterJobId: row.waterJobId,
      scopeTurnId: row.scopeTurnId,
      purpose: row.purpose as JobComputeIdentity['purpose'],
    };
    const issuedSecret = `uoa_job_${'c'.repeat(43)}`;
    await db.billingAppKey.update({
      where: { id: 'app-key-job-water' },
      data: { lastUsedAt: null },
    });
    const result = await renewJobComputeAuthority(
      { appKey, secret: issuedSecret, grantId: row.id, identity: issuedIdentity },
      { prisma: db },
    );
    expect(
      (await db.billingAppKey.findUniqueOrThrow({ where: { id: 'app-key-job-water' } })).lastUsedAt,
    ).toBeNull();
    const verified = await jwtVerify(
      result.access_token,
      createLocalJWKSet(await getAccessTokenPublicJwks()),
      {
        issuer: 'https://authentication.unlikeotherai.com',
        audience: 'https://ledger.unlikeotherai.com',
      },
    );
    expect(verified.payload).toMatchObject({
      sub: 'subject-job-test',
      tv: 0,
      source_domain: 'api.deepwater.live',
      product: 'deepwater',
      job_compute: {
        grant_id: row.id,
        origin_invocation_id: row.originInvocationId,
        ledger_job_id: row.ledgerJobId,
        water_job_id: row.waterJobId,
      },
    });
    expect(verified.payload.exp! - verified.payload.iat!).toBeLessThanOrEqual(120);
    const dispatch = {
      claim: verified.payload.job_compute,
      identity: { ...issuedIdentity, grantId: row.id },
      runtimeKeyId: 'key-job-water',
      subjectId: row.subjectId,
      orgId: row.orgId,
      teamId: row.teamId,
      tokenVersion: row.tokenVersion,
      identityDomain: row.identityDomain,
      now: new Date(),
    };
    await expect(
      db.$transaction((tx) => assertLiveJobComputeDispatch(tx, dispatch)),
    ).resolves.toBeUndefined();
    await db.billingJobComputeRenewal.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() + 25_000) },
    });
    const nearExpiry = await renewJobComputeAuthority(
      { appKey, secret: issuedSecret, grantId: row.id, identity: issuedIdentity },
      { prisma: db },
    );
    expect(nearExpiry.expires_in).toBeGreaterThan(0);
    expect(nearExpiry.expires_in).toBeLessThanOrEqual(25);
    await revokeJobComputeRenewal(
      { appKey, secret: issuedSecret, grantId: row.id, identity: issuedIdentity },
      { prisma: db },
    );
    await expect(
      db.$transaction((tx) => assertLiveJobComputeDispatch(tx, dispatch)),
    ).rejects.toThrow('JOB_COMPUTE_DISPATCH_MISMATCH');
  });

  it('refuses a revoked grant at reservation even with a signed, unexpired claim', async () => {
    await expect(
      db.$transaction((tx) =>
        assertLiveJobComputeDispatch(tx, {
          claim: {
            grant_id: grantId,
            origin_invocation_id: identity.originInvocationId,
            ledger_job_id: identity.ledgerJobId,
            water_job_id: identity.waterJobId,
            scope_turn_id: null,
            purpose: identity.purpose,
            origin_product: 'nessie',
            origin_source_domain: 'api.nessie.works',
          },
          identity: { ...identity, grantId },
          runtimeKeyId: 'key-job-origin',
          subjectId: 'subject-job-test',
          orgId: 'org-job-test',
          teamId: 'team-job-test',
          tokenVersion: 0,
          identityDomain: 'api.nessie.works',
          now: new Date(),
        }),
      ),
    ).rejects.toThrow('JOB_COMPUTE_DISPATCH_MISMATCH');
  });

  it('recovers migrated identifiers without changing authority or valid identifiers', async () => {
    const original = await db.billingJobComputeRenewal.findUniqueOrThrow({
      where: { id: grantId },
    });
    const input = {
      ...identity,
      ledgerJobId: 'ledger-job-migration-test',
      issueKey: '8'.repeat(64),
      secret: `uoa_job_${'j'.repeat(43)}`,
    };
    await issueJobComputeRenewal(
      { runtimeSecret, delegation: await freshOriginalDelegation(), input },
      { prisma: db },
    );
    const before = await db.billingJobComputeRenewal.findUniqueOrThrow({
      where: { issueKey: input.issueKey },
    });
    const legacyId = 'cmlegacygrant0000000000000';
    const migration = readFileSync(
      new URL(
        '../../prisma/migrations/20261007103000_job_compute_grant_uuid/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE billing_job_compute_renewals DROP CONSTRAINT billing_job_compute_grant_id_uuid',
      );
      await tx.billingJobComputeRenewal.update({
        where: { id: before.id },
        data: { id: legacyId },
      });
      await tx.$executeRawUnsafe(migration);
    });
    const migrated = await db.billingJobComputeRenewal.findUniqueOrThrow({
      where: { issueKey: input.issueKey },
    });
    expect(migrated.id).toMatch(grantUuid);
    expect({ ...migrated, id: before.id }).toEqual(before);
    expect(await recoverJobComputeRenewal({ runtimeSecret, input }, { prisma: db })).toMatchObject({
      grant_id: migrated.id,
      expires_at: before.expiresAt.toISOString(),
    });
    expect(await db.billingJobComputeRenewal.findUnique({ where: { id: original.id } })).toEqual(
      original,
    );
    await expect(
      db.billingJobComputeRenewal.update({ where: { id: migrated.id }, data: { id: legacyId } }),
    ).rejects.toThrow(/constraint/i);
  });

  it('refuses recovery when the original login epoch has changed', async () => {
    const input = {
      ...identity,
      ledgerJobId: 'ledger-job-epoch-test',
      issueKey: '4'.repeat(64),
      secret: `uoa_job_${'f'.repeat(43)}`,
    };
    await issueJobComputeRenewal(
      { runtimeSecret, delegation: await freshOriginalDelegation(), input },
      { prisma: db },
    );
    await db.user.update({ where: { id: 'subject-job-test' }, data: { tokenVersion: 1 } });
    await expect(
      recoverJobComputeRenewal({ runtimeSecret, input }, { prisma: db }),
    ).rejects.toThrow('AUTHENTICATION_FAILED');
    const row = await db.billingJobComputeRenewal.findUniqueOrThrow({
      where: { issueKey: input.issueKey },
    });
    await expect(
      revokeJobComputeRenewalFromOrigin(
        {
          runtimeSecret,
          issueKey: input.issueKey,
          grantId: row.id,
          identity: { ...identity, ledgerJobId: 'wrong' },
        },
        { prisma: db },
      ),
    ).rejects.toThrow('JOB_COMPUTE_RENEWAL_DENIED');
    await expect(
      revokeJobComputeRenewalFromOrigin(
        {
          runtimeSecret,
          issueKey: 'f'.repeat(64),
          grantId: row.id,
          identity: { ...identity, ledgerJobId: input.ledgerJobId },
        },
        { prisma: db },
      ),
    ).rejects.toThrow('JOB_COMPUTE_RENEWAL_DENIED');
    await expect(
      revokeJobComputeRenewalFromOrigin(
        {
          runtimeSecret,
          issueKey: input.issueKey,
          grantId: row.id,
          identity: { ...identity, ledgerJobId: input.ledgerJobId },
        },
        { prisma: db },
      ),
    ).resolves.toEqual({ revoked: true });
    expect(
      (
        await db.billingJobComputeRenewal.findUniqueOrThrow({
          where: { id: row.id },
        })
      ).revokedAt,
    ).not.toBeNull();
  });
});
