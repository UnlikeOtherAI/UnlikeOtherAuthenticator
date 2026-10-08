import Fastify from 'fastify';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as prismaProvider from '../../src/db/prisma.js';
import { registerJobComputeRenewalRoutes } from '../../src/routes/billing/job-compute-renewals.js';
import {
  assertLiveJobComputeDispatch,
  issueJobComputeRenewal,
  recoverJobComputeRenewal,
  renewJobComputeAuthority,
  revokeJobComputeRenewal,
} from '../../src/services/billing-job-compute-renewal.service.js';
import { getAccessTokenPublicJwks } from '../../src/services/oauth/access-token.service.js';
import {
  appKey,
  runtimeSecret,
  salesRuntimeSecret,
  salesSourceDomain,
  salesOrgId,
  salesTeamId,
  grantId,
  grantUuid,
  identity,
  secret,
  freshOriginalDelegation,
  setupJobComputeFixture,
  teardownJobComputeFixture,
  enabled,
  db,
} from './helpers/billing-job-compute-renewal-fixture.js';

describe.skipIf(!enabled)('finite job-compute grant issuance in PostgreSQL', () => {
  beforeAll(setupJobComputeFixture);
  afterAll(teardownJobComputeFixture);
  it('issues once from a fresh UOA token and preserves first expiry on lost acknowledgement', async () => {
    const delegation = await freshOriginalDelegation();
    const input = {
      ...identity,
      ledgerJobId: 'ledger-job-issue-test',
      issueKey: '3'.repeat(64),
      secret: `uoa_job_${'c'.repeat(43)}`,
    };
    const first = await issueJobComputeRenewal(
      { runtimeSecret, delegation, input },
      { prisma: db },
    );
    expect(first.grant_id).toMatch(grantUuid);
    const replay = await issueJobComputeRenewal(
      { runtimeSecret, delegation, input },
      { prisma: db },
    );
    expect(replay).toEqual(first);
    expect(await recoverJobComputeRenewal({ runtimeSecret, input }, { prisma: db })).toEqual(first);
    expect(await db.billingJobComputeRenewal.count({ where: { issueKey: input.issueKey } })).toBe(
      1,
    );
    const row = await db.billingJobComputeRenewal.findUniqueOrThrow({
      where: { issueKey: input.issueKey },
    });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(JSON.stringify(row)).not.toContain(input.secret);
    await expect(
      issueJobComputeRenewal(
        { runtimeSecret, delegation, input: { ...input, secret: `uoa_job_${'e'.repeat(43)}` } },
        { prisma: db },
      ),
    ).rejects.toThrow('JOB_COMPUTE_ISSUE_CONFLICT');
    await expect(
      recoverJobComputeRenewal(
        { runtimeSecret, input: { ...input, secret: `uoa_job_${'e'.repeat(43)}` } },
        { prisma: db },
      ),
    ).rejects.toThrow('JOB_COMPUTE_RENEWAL_DENIED');
  });

  it('requires exact frozen lineage, then revokes durably and refuses renewal', async () => {
    await expect(
      revokeJobComputeRenewal(
        { appKey, secret, grantId, identity: { ...identity, ledgerJobId: 'different-job' } },
        { prisma: db },
      ),
    ).rejects.toThrow('JOB_COMPUTE_RENEWAL_DENIED');
    expect(
      (await db.billingJobComputeRenewal.findUniqueOrThrow({ where: { id: grantId } })).revokedAt,
    ).toBeNull();
    await expect(
      revokeJobComputeRenewal({ appKey, secret: `${secret}z`, grantId, identity }, { prisma: db }),
    ).rejects.toThrow();
    await expect(
      revokeJobComputeRenewal({ appKey, secret, grantId, identity }, { prisma: db }),
    ).resolves.toEqual({ revoked: true });
    const row = await db.billingJobComputeRenewal.findUniqueOrThrow({ where: { id: grantId } });
    expect(row.revokedAt).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(secret);
    await expect(
      renewJobComputeAuthority({ appKey, secret, grantId, identity }, { prisma: db }),
    ).rejects.toThrow('JOB_COMPUTE_RENEWAL_DENIED');
  });

  it('binds Water compute authority to the Sales parent grant and stops renewal on revoke', async () => {
    const now = new Date();
    const parentGrantId = randomUUID();
    const parentRequestId = randomUUID();
    const parentJobId = `j_sales_parent_${randomUUID()}`;
    const authorizedUntil = new Date(now.getTime() + 60 * 60 * 1000);
    const parent = await db.salesResearchJobGrant.create({
      data: {
        id: parentGrantId,
        clientDomainId: salesClientDomainId,
        requestId: parentRequestId,
        jobId: parentJobId,
        sourceDomain: salesSourceDomain,
        subjectId: 'subject-job-test',
        orgId: salesOrgId,
        teamId: salesTeamId,
        tokenVersion: 0,
        originTokenJti: randomUUID(),
        product: 'salesnerd',
        resource: 'https://ledger.unlikeotherai.com',
        purpose: 'research_job',
        bindingHash: 'a'.repeat(64),
        authorizedUntil,
        createdAt: now,
      },
    });
    const childInput = {
      ...identity,
      originInvocationId: parentJobId,
      ledgerJobId: `ledger-child-${randomUUID()}`,
      issueKey: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      secret: `uoa_job_${'p'.repeat(43)}`,
    };
    const delegation = await salesParentDelegation({
      grantHandle: parent.id,
      requestId: parentRequestId,
      jobId: parentJobId,
      authorizedUntil,
    });
    const wrongParent = await salesParentDelegation({
      grantHandle: randomUUID(),
      requestId: parentRequestId,
      jobId: parentJobId,
      authorizedUntil,
    });
    await expect(
      issueJobComputeRenewal(
        {
          runtimeSecret: salesRuntimeSecret,
          delegation: wrongParent,
          input: {
            ...childInput,
            ledgerJobId: `ledger-wrong-parent-${randomUUID()}`,
            issueKey: randomUUID().replaceAll('-', '').padEnd(64, '2').slice(0, 64),
          },
        },
        { prisma: db, now },
      ),
    ).rejects.toThrow('JOB_COMPUTE_PARENT_AUTHORIZATION_INVALID');
    const child = await issueJobComputeRenewal(
      { runtimeSecret: salesRuntimeSecret, delegation, input: childInput },
      { prisma: db, now },
    );
    const persisted = await db.billingJobComputeRenewal.findUniqueOrThrow({
      where: { id: child.grant_id },
    });
    expect(persisted.parentSalesJobGrantId).toBe(parent.id);
    expect(persisted.expiresAt.getTime()).toBeLessThanOrEqual(authorizedUntil.getTime());
    await expect(
      renewJobComputeAuthority(
        { appKey, secret: childInput.secret, grantId: child.grant_id, identity: childInput },
        { prisma: db },
      ),
    ).resolves.toMatchObject({
      token_type: 'Bearer',
    });

    await db.salesResearchJobGrant.update({
      where: { id: parent.id },
      data: { revokedAt: new Date() },
    });
    await expect(
      renewJobComputeAuthority(
        { appKey, secret: childInput.secret, grantId: child.grant_id, identity: childInput },
        { prisma: db },
      ),
    ).rejects.toThrow('JOB_COMPUTE_PARENT_AUTHORIZATION_INVALID');
    await expect(
      recoverJobComputeRenewal(
        { runtimeSecret: salesRuntimeSecret, input: childInput },
        { prisma: db },
      ),
    ).rejects.toThrow('JOB_COMPUTE_PARENT_AUTHORIZATION_INVALID');
    const dispatchIdentity = {
      ...identity,
      originInvocationId: parentJobId,
      ledgerJobId: childInput.ledgerJobId,
      grantId: child.grant_id,
    };
    await expect(
      assertLiveJobComputeDispatch(db, {
        claim: {
          grant_id: child.grant_id,
          origin_invocation_id: parentJobId,
          ledger_job_id: childInput.ledgerJobId,
          water_job_id: identity.waterJobId,
          scope_turn_id: null,
          purpose: 'research_compute',
          origin_product: 'salesnerd',
          origin_source_domain: salesSourceDomain,
        },
        identity: dispatchIdentity,
        runtimeKeyId: 'key-job-water',
        subjectId: 'subject-job-test',
        orgId: salesOrgId,
        teamId: salesTeamId,
        tokenVersion: 0,
        identityDomain: salesSourceDomain,
        now: new Date(),
      }),
    ).rejects.toThrow('JOB_COMPUTE_PARENT_AUTHORIZATION_INVALID');

    const expiringParentId = randomUUID();
    const expiringRequestId = randomUUID();
    const expiringJobId = `j_sales_expiring_parent_${randomUUID()}`;
    const expiringAt = new Date(now.getTime() + 45_000);
    const expiringParent = await db.salesResearchJobGrant.create({
      data: {
        id: expiringParentId,
        clientDomainId: salesClientDomainId,
        requestId: expiringRequestId,
        jobId: expiringJobId,
        sourceDomain: salesSourceDomain,
        subjectId: 'subject-job-test',
        orgId: salesOrgId,
        teamId: salesTeamId,
        tokenVersion: 0,
        originTokenJti: randomUUID(),
        product: 'salesnerd',
        resource: 'https://ledger.unlikeotherai.com',
        purpose: 'research_job',
        bindingHash: 'b'.repeat(64),
        authorizedUntil: expiringAt,
        createdAt: now,
      },
    });
    const expiringInput = {
      ...identity,
      originInvocationId: expiringJobId,
      ledgerJobId: `ledger-expiring-child-${randomUUID()}`,
      issueKey: randomUUID().replaceAll('-', '').padEnd(64, '1').slice(0, 64),
      secret: `uoa_job_${'q'.repeat(43)}`,
    };
    const expiringDelegation = await salesParentDelegation({
      grantHandle: expiringParent.id,
      requestId: expiringRequestId,
      jobId: expiringJobId,
      authorizedUntil: expiringAt,
    });
    const expiringChild = await issueJobComputeRenewal(
      { runtimeSecret: salesRuntimeSecret, delegation: expiringDelegation, input: expiringInput },
      { prisma: db, now },
    );
    const expiringChildRow = await db.billingJobComputeRenewal.findUniqueOrThrow({
      where: { id: expiringChild.grant_id },
    });
    expect(expiringChildRow.expiresAt).toEqual(expiringAt);
    await expect(
      renewJobComputeAuthority(
        {
          appKey,
          secret: expiringInput.secret,
          grantId: expiringChild.grant_id,
          identity: expiringInput,
        },
        { prisma: db, now: new Date(expiringAt.getTime() + 1_000) },
      ),
    ).rejects.toThrow('JOB_COMPUTE_RENEWAL_DENIED');
  });

  it('concurrent identical issue requests converge to one durable grant', async () => {
    const delegation = await freshOriginalDelegation();
    const input = {
      ...identity,
      ledgerJobId: 'ledger-job-concurrent-test',
      issueKey: '5'.repeat(64),
      secret: `uoa_job_${'g'.repeat(43)}`,
    };
    const [first, second] = await Promise.all([
      issueJobComputeRenewal({ runtimeSecret, delegation, input }, { prisma: db }),
      issueJobComputeRenewal({ runtimeSecret, delegation, input }, { prisma: db }),
    ]);
    expect(second).toEqual(first);
    expect(await db.billingJobComputeRenewal.count({ where: { issueKey: input.issueKey } })).toBe(
      1,
    );
  });

  it('renews through HTTP with the exact identifier returned by persisted issuance', async () => {
    const provider = vi.spyOn(prismaProvider, 'getAdminPrisma').mockReturnValue(db);
    const app = Fastify();
    registerJobComputeRenewalRoutes(app);
    const body = {
      origin_invocation_id: identity.originInvocationId,
      ledger_job_id: 'ledger-job-http-test',
      water_job_id: identity.waterJobId,
      scope_turn_id: null,
      purpose: identity.purpose,
    };
    const httpSecret = `uoa_job_${'h'.repeat(43)}`;
    try {
      const issued = await app.inject({
        method: 'POST',
        url: '/billing/v1/ledger/job-compute-renewals',
        headers: {
          authorization: `Bearer ${runtimeSecret}`,
          'x-uoa-delegation': await freshOriginalDelegation(),
        },
        payload: { ...body, issue_key: '6'.repeat(64), secret: httpSecret },
      });
      expect(issued.statusCode).toBe(200);
      const result = issued.json<{ grant_id: string }>();
      expect(result.grant_id).toMatch(grantUuid);
      const renewed = await app.inject({
        method: 'POST',
        url: `/billing/v1/job-compute-renewals/${result.grant_id}/renew`,
        headers: { authorization: `Bearer ${appKey}` },
        payload: { ...body, secret: httpSecret },
      });
      expect(renewed.statusCode).toBe(200);
      const verified = await jwtVerify(
        renewed.json<{ access_token: string }>().access_token,
        createLocalJWKSet(await getAccessTokenPublicJwks()),
      );
      expect(verified.payload.job_compute).toMatchObject({
        grant_id: result.grant_id,
        ledger_job_id: body.ledger_job_id,
        water_job_id: body.water_job_id,
      });
    } finally {
      await app.close();
      provider.mockRestore();
    }
  });
});
