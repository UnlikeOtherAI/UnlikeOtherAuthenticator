import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import Fastify from 'fastify';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as prismaProvider from '../../src/db/prisma.js';
import { registerJobComputeRenewalRoutes } from '../../src/routes/billing/job-compute-renewals.js';
import { continueJobComputeRenewal } from '../../src/services/billing-job-compute-continuation.service.js';
import { issueJobComputeRenewal, renewJobComputeAuthority, revokeJobComputeRenewal,
  assertLiveJobComputeDispatch } from '../../src/services/billing-job-compute-renewal.service.js';
import { getAccessTokenPublicJwks, signConfidentialAccessToken } from '../../src/services/oauth/access-token.service.js';
import { lockRefreshSessionUserDomain } from '../../src/services/refresh-session-lock.service.js';
import { updateAdminDomain } from '../../src/services/domain-secret.service.js';
import { appKey, waterRuntimeSecret, runtimeSecret, identity, db, enabled,
  deferred, waitForEpochLockWaiters,
  setupJobComputeFixture, teardownJobComputeFixture } from './helpers/billing-job-compute-renewal-fixture.js';

function issueInput() {
  return { ...identity, ledgerJobId: `rs_${randomUUID()}`, issueKey: randomBytes(32).toString('hex'),
    secret: `uoa_job_${randomBytes(32).toString('base64url')}` };
}
async function waitForPolicyReader(): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const rows = await db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%pg_advisory_xact_lock_shared%'`);
    if ((rows[0]?.count ?? 0n) > 0n) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Expected continuation to wait for the product policy lock.');
}
function freshWaterDelegation() {
  return signConfidentialAccessToken({ subject: 'subject-job-test', credentialEpoch: 0,
    email: 'job@example.com', sourceDomain: 'api.deepwater.live', product: 'deepwater',
    resource: 'https://ledger.unlikeotherai.com', issuer: 'https://authentication.unlikeotherai.com',
    ttlSeconds: 45, scope: 'ai.invoke', active: { orgId: 'org-job-test', teamId: 'team-job-test' },
    org: { org_id: 'org-job-test', org_role: 'owner', teams: ['team-job-test'],
      team_roles: { 'team-job-test': 'owner' } } });
}
async function parentGrant() {
  const input = issueInput();
  const issued = await issueJobComputeRenewal({ runtimeSecret: waterRuntimeSecret,
    delegation: await freshWaterDelegation(), input }, { prisma: db });
  const token = await renewJobComputeAuthority({ appKey, secret: input.secret,
    grantId: issued.grant_id, identity: input }, { prisma: db });
  return { input, issued, delegation: token.access_token };
}
async function childGrant(parent: Awaited<ReturnType<typeof parentGrant>>) {
  const input = issueInput();
  const issued = await continueJobComputeRenewal({ runtimeSecret: waterRuntimeSecret,
    delegation: parent.delegation, grantId: parent.issued.grant_id, input }, { prisma: db });
  return { input, issued };
}

describe.skipIf(!enabled)('bounded DeepWater attempt continuation in PostgreSQL', () => {
  beforeAll(async () => {
    await setupJobComputeFixture();
    await db.domainRole.create({ data: { domain: 'api.deepwater.live', userId: 'subject-job-test', role: 'USER' } });
  });
  afterAll(teardownJobComputeFixture);

  it('derives exactly one child under concurrent response-loss replay and keeps the original expiry', async () => {
    const parent = await parentGrant();
    const input = issueInput();
    const params = { runtimeSecret: waterRuntimeSecret, delegation: parent.delegation,
      grantId: parent.issued.grant_id, input };
    const results = await Promise.all(Array.from({ length: 3 }, () => continueJobComputeRenewal(params, { prisma: db })));
    expect(new Set(results.map((result) => result.grant_id)).size).toBe(1);
    expect(results[0]?.expires_at).toBe(parent.issued.expires_at);
    const child = await db.billingJobComputeRenewal.findUniqueOrThrow({ where: { id: results[0]!.grant_id } });
    const original = await db.billingJobComputeRenewal.findUniqueOrThrow({ where: { id: parent.issued.grant_id } });
    for (const field of ['subjectId', 'orgId', 'teamId', 'tokenVersion', 'identityDomain',
      'originInvocationId', 'originRuntimeKeyId', 'originTokenJti', 'originalActorChain',
      'waterJobId', 'originProduct', 'originSourceDomain', 'expiresAt'] as const) {
      expect(child[field]).toEqual(original[field]);
    }
    expect(child.continuationOfId).toBe(original.id);
    expect(child.ledgerJobId).toBe(input.ledgerJobId);
    expect(await db.billingJobComputeRenewal.count({ where: { continuationOfId: original.id } })).toBe(1);
    await expect(continueJobComputeRenewal({ ...params, input: issueInput() }, { prisma: db }))
      .rejects.toThrow('JOB_COMPUTE_CONTINUATION_CONFLICT');
  });

  it('rejects cross-run, cross-invocation, same-attempt and wrong-runtime continuations', async () => {
    const parent = await parentGrant();
    const base = { runtimeSecret: waterRuntimeSecret, delegation: parent.delegation,
      grantId: parent.issued.grant_id, input: issueInput() };
    for (const input of [{ ...base.input, waterJobId: randomUUID() },
      { ...base.input, originInvocationId: 'other-invocation' },
      { ...base.input, ledgerJobId: parent.input.ledgerJobId }]) {
      await expect(continueJobComputeRenewal({ ...base, input }, { prisma: db })).rejects.toThrow();
    }
    await expect(continueJobComputeRenewal({ ...base, runtimeSecret }, { prisma: db })).rejects.toThrow();
    await expect(continueJobComputeRenewal({ ...base, delegation: await freshWaterDelegation() }, { prisma: db }))
      .rejects.toThrow();
    expect(await db.billingJobComputeRenewal.count({ where: { continuationOfId: parent.issued.grant_id } })).toBe(0);
  });

  it('does not let a job-bound token mint an unrelated fresh launch grant', async () => {
    const parent = await parentGrant();
    await expect(issueJobComputeRenewal({ runtimeSecret: waterRuntimeSecret,
      delegation: parent.delegation, input: issueInput() }, { prisma: db }))
      .rejects.toThrow('JOB_COMPUTE_ORIGIN_MISMATCH');
  });

  it('cannot extend an expired ancestor or rewrite derived authority', async () => {
    const parent = await parentGrant();
    const child = await childGrant(parent);
    await expect(renewJobComputeAuthority({ appKey, secret: child.input.secret,
      grantId: child.issued.grant_id, identity: child.input },
    { prisma: db, now: new Date(Date.parse(parent.issued.expires_at) + 1) })).rejects.toThrow();
    await expect(db.billingJobComputeRenewal.update({ where: { id: child.issued.grant_id },
      data: { teamId: 'different-team' } })).rejects.toThrow(/immutable/);
    await expect(db.billingJobComputeRenewal.update({ where: { id: child.issued.grant_id },
      data: { expiresAt: new Date(Date.parse(parent.issued.expires_at) + 1_000) } }))
      .rejects.toThrow(/immutable/);
  });

  it('blocks descendants at renewal, dispatch and further continuation after ancestor revocation', async () => {
    const parent = await parentGrant();
    const child = await childGrant(parent);
    const token = await renewJobComputeAuthority({ appKey, secret: child.input.secret,
      grantId: child.issued.grant_id, identity: child.input }, { prisma: db });
    const { payload } = await jwtVerify(token.access_token, createLocalJWKSet(await getAccessTokenPublicJwks()));
    const dispatch = { claim: payload.job_compute, identity: { ...child.input, grantId: child.issued.grant_id },
      runtimeKeyId: 'key-job-water', subjectId: 'subject-job-test', orgId: 'org-job-test',
      teamId: 'team-job-test', tokenVersion: 0, identityDomain: 'api.deepwater.live', now: new Date() };
    await db.$transaction((tx) => assertLiveJobComputeDispatch(tx, dispatch));
    await revokeJobComputeRenewal({ appKey, secret: parent.input.secret,
      grantId: parent.issued.grant_id, identity: parent.input }, { prisma: db });
    await expect(renewJobComputeAuthority({ appKey, secret: child.input.secret,
      grantId: child.issued.grant_id, identity: child.input }, { prisma: db })).rejects.toThrow();
    await expect(db.$transaction((tx) => assertLiveJobComputeDispatch(tx, dispatch)))
      .rejects.toThrow('JOB_COMPUTE_DISPATCH_MISMATCH');
    await expect(continueJobComputeRenewal({ runtimeSecret: waterRuntimeSecret,
      delegation: token.access_token, grantId: child.issued.grant_id, input: issueInput() }, { prisma: db }))
      .rejects.toThrow();
  });

  it('rechecks membership and credential epoch instead of borrowing the original login', async () => {
    const parent = await parentGrant();
    const params = { runtimeSecret: waterRuntimeSecret, delegation: parent.delegation,
      grantId: parent.issued.grant_id, input: issueInput() };
    await db.teamMember.update({ where: { id: 'team-member-job' }, data: { status: 'REMOVED' } });
    try { await expect(continueJobComputeRenewal(params, { prisma: db })).rejects.toThrow(); }
    finally { await db.teamMember.update({ where: { id: 'team-member-job' }, data: { status: 'ACTIVE' } }); }
    await db.user.update({ where: { id: 'subject-job-test' }, data: { tokenVersion: 1 } });
    try { await expect(continueJobComputeRenewal(params, { prisma: db })).rejects.toThrow(); }
    finally { await db.user.update({ where: { id: 'subject-job-test' }, data: { tokenVersion: 0 } }); }
    expect(await db.billingJobComputeRenewal.count({ where: { continuationOfId: parent.issued.grant_id } })).toBe(0);
  });

  it('rejects continuation when credential revocation commits while it waits for the epoch lock', async () => {
    // Exercise an ordinary member; continuation must observe revocation
    // independently of any canonical-owner or seat-admission row conflict.
    await db.user.create({ data: { id: 'other-owner', userKey: 'owner@example.com', email: 'owner@example.com' } });
    await db.orgMember.create({ data: { orgId: 'org-job-test', userId: 'other-owner',
      domain: 'api.nessie.works', role: 'owner' } });
    await db.teamMember.create({ data: { teamId: 'team-job-test', userId: 'other-owner', teamRole: 'owner' } });
    await db.organisation.update({ where: { id: 'org-job-test' }, data: { ownerId: 'other-owner' } });
    await db.orgMember.update({ where: { id: 'org-member-job' }, data: { role: 'member' } });
    await db.teamMember.update({ where: { id: 'team-member-job' }, data: { teamRole: 'member' } });
    const parent = await parentGrant();
    const verified = deferred();
    const beginTransaction = deferred();
    // Schedule the race after actual token verification. Otherwise the outer
    // verifier can reject first and leave the transaction snapshot untested.
    const gated = new Proxy(db, { get(target, property, receiver) {
      if (property === '$transaction') return async (...args: Parameters<typeof db.$transaction>) => {
        if (typeof args[0] === 'function' && args[0].name === 'continueExistingGrant') {
          verified.resolve();
          await beginTransaction.promise;
        }
        return db.$transaction(...args);
      };
      return Reflect.get(target, property, receiver);
    } });
    const continuation = continueJobComputeRenewal({ runtimeSecret: waterRuntimeSecret,
      delegation: parent.delegation, grantId: parent.issued.grant_id, input: issueInput() }, { prisma: gated })
      .then(() => ({ accepted: true }), (error: unknown) => ({ accepted: false, error }));
    await verified.promise;
    const entered = deferred();
    const release = deferred();
    const revocation = db.$transaction(async (tx) => {
      await lockRefreshSessionUserDomain({ userId: 'subject-job-test', domain: 'api.deepwater.live' }, { prisma: tx });
      entered.resolve();
      await release.promise;
      await tx.user.update({ where: { id: 'subject-job-test' }, data: { tokenVersion: 1 } });
    }, { timeout: 10_000 });
    await entered.promise;
    beginTransaction.resolve();
    try {
      await waitForEpochLockWaiters(1);
      release.resolve();
      await revocation;
      const outcome = await continuation;
      expect(await db.billingJobComputeRenewal.count({ where: { continuationOfId: parent.issued.grant_id } })).toBe(0);
      expect(outcome).toMatchObject({ accepted: false, error: { message: 'AUTHENTICATION_FAILED' } });
    } finally {
      beginTransaction.resolve();
      release.resolve();
      await Promise.allSettled([revocation, continuation]);
      await db.user.update({ where: { id: 'subject-job-test' }, data: { tokenVersion: 0 } });
    }
  });

  it('exercises the HTTP continuation and recipient renewal contract', async () => {
    const parent = await parentGrant();
    const input = issueInput();
    const provider = vi.spyOn(prismaProvider, 'getAdminPrisma').mockReturnValue(db);
    const app = Fastify();
    registerJobComputeRenewalRoutes(app);
    const body = { origin_invocation_id: input.originInvocationId, ledger_job_id: input.ledgerJobId,
      water_job_id: input.waterJobId, scope_turn_id: null, purpose: input.purpose,
      issue_key: input.issueKey, secret: input.secret };
    try {
      const response = await app.inject({ method: 'POST',
        url: `/billing/v1/ledger/job-compute-renewals/${parent.issued.grant_id}/continue`,
        headers: { authorization: `Bearer ${waterRuntimeSecret}`, 'x-uoa-delegation': parent.delegation },
        payload: body });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const grant = response.json<{ grant_id: string }>();
      const renewed = await app.inject({ method: 'POST', url: `/billing/v1/job-compute-renewals/${grant.grant_id}/renew`,
        headers: { authorization: `Bearer ${appKey}` }, payload: { ...body, issue_key: undefined } });
      expect(renewed.statusCode).toBe(200);
      const { payload } = await jwtVerify(renewed.json<{ access_token: string }>().access_token,
        createLocalJWKSet(await getAccessTokenPublicJwks()));
      expect(payload.job_compute).toMatchObject({ grant_id: grant.grant_id,
        ledger_job_id: input.ledgerJobId, water_job_id: input.waterJobId });
    } finally { await app.close(); provider.mockRestore(); }
  });

  it('rejects continuation when its source domain is disabled while it waits for policy', async () => {
    const parent = await parentGrant();
    const verified = deferred();
    const begin = deferred();
    const gated = new Proxy(db, { get(target, property, receiver) {
      if (property === '$transaction') return async (...args: Parameters<typeof db.$transaction>) => {
        if (typeof args[0] === 'function' && args[0].name === 'continueExistingGrant') {
          verified.resolve(); await begin.promise;
        }
        return db.$transaction(...args);
      };
      return Reflect.get(target, property, receiver);
    } });
    const continuation = continueJobComputeRenewal({ runtimeSecret: waterRuntimeSecret,
      delegation: parent.delegation, grantId: parent.issued.grant_id, input: issueInput() }, { prisma: gated })
      .then(() => ({ accepted: true }), () => ({ accepted: false }));
    await verified.promise;
    const entered = deferred();
    const release = deferred();
    const disable = updateAdminDomain({ domain: 'api.deepwater.live', status: 'disabled',
      actorEmail: 'operator@example.com' }, { prisma: db,
      afterProductPolicyLock: async () => { entered.resolve(); await release.promise; } });
    await entered.promise;
    begin.resolve();
    try {
      await waitForPolicyReader();
      release.resolve();
      await disable;
      const outcome = await continuation;
      expect(await db.billingJobComputeRenewal.count({ where: { continuationOfId: parent.issued.grant_id } })).toBe(0);
      expect(outcome.accepted).toBe(false);
    } finally {
      begin.resolve(); release.resolve();
      await Promise.allSettled([disable, continuation]);
      await updateAdminDomain({ domain: 'api.deepwater.live', status: 'active',
        actorEmail: 'operator@example.com' }, { prisma: db });
    }
  });
});
