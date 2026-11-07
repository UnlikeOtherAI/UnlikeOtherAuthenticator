import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { SignJWT } from 'jose';
import { expect, it } from 'vitest';
import { finalizePrepaidDispatch } from '../../src/services/billing-prepaid-reservation.service.js';

import { releaseBudgetDispatch, reserveBudgetDispatch } from '../../src/services/billing-credit-budget-dispatch.service.js';

import { listCreditBudgets, putCreditBudget, registerNativeBudgetScope } from '../../src/services/billing-credit-budget-management.service.js';

import { ids, secret, prisma, signingKey, actorCredential, issuer, signedCurrentBudgetProof, reserveFixture } from './billing-prepaid-reservation.suite-fixture.js';

export function registerCases2() {
  it('uses one prepaid account carry across services, a month boundary, and a late legacy receipt', async () => {
    const otherService = 'svc_prepaid_rating_other';
    const otherTariff = 'tariff_prepaid_rating_other';
    const otherKey = 'ledger_key_prepaid_rating_other';
    const otherSecret = `uoa_ledger_${'c'.repeat(43)}`;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`INSERT INTO billing_services
        (id, identifier, name, tariff_history_from_month, updated_at)
        VALUES (${otherService}, 'deeptest', 'DeepTest', '2026-10', CURRENT_TIMESTAMP)`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO billing_tariffs
        (id, service_id, key, version, name, mode, collection_mode,
          markup_bps, currency, usage_payment_mode)
        VALUES (${otherTariff}, ${otherService}, 'prepaid', 1, 'Prepaid', 'STANDARD',
          'NONE', 1000, 'USD', 'PREPAID')`);
      await tx.billingLedgerRuntimeKey.create({ data: {
        id: otherKey, serviceId: otherService,
        secretDigest: createHash('sha256').update(otherSecret).digest('hex'),
        keyPrefix: otherSecret.slice(0, 18), ledgerAudience: 'https://ledger.example.com',
        sourceDomain: 'deeptest.example.com', createdByEmail: 'admin@example.com',
      } });
    });
    const cutover = await prisma.billingCreditBudgetCutover.findUniqueOrThrow({ where: { id: 1 } });
    await prisma.billingCreditBudgetCutover.update({ where: { id: 1 },
      data: { occurredAt: new Date('2026-10-04T11:00:00.000Z') } });
    try {
      // This frozen old-path request starts after migration, before full rollout.
      await reserveFixture(300);
      const opening = (await prisma.billingCreditAccount.findUniqueOrThrow({
        where: { id: ids.credit },
      })).balanceMicrocredits;
      const settleForward = async (index: number, inNovember: boolean, other: boolean) => {
        const startedAt = new Date(inNovember ? '2026-11-01T00:00:01.000Z'
          : '2026-10-04T18:00:00.000Z');
        const serviceId = other ? otherService : ids.service;
        const tariffId = other ? otherTariff : ids.tariff;
        const keyId = other ? otherKey : ids.key;
        const dispatchId = `dispatch-prepaid-${index}`;
        await reserveFixture(index, '0.00000000013', tariffId, 1n,
          { serviceId, keyId, startedAt });
        await prisma.$transaction((tx) => reserveBudgetDispatch(tx, {
          dispatchId, requestFingerprint: 'a'.repeat(64), startedAt,
          product: other ? 'deeptest' : 'deepwater',
          serviceId, providerServiceId: 'openai', orgId: ids.org, teamId: ids.team,
          userId: ids.user, billingMonth: startedAt.toISOString().slice(0, 7),
          currency: 'USD', tariffId, tariffMode: 'STANDARD',
          markupBps: other ? 1000 : 0, paymentMode: 'PREPAID',
          rawCostBound: new Prisma.Decimal('0.00000000013'), context: null,
        }));
        const settled = await finalizePrepaidDispatch({
          runtimeSecret: other ? otherSecret : secret,
          dispatchId, receiptId: `receipt-prepaid-${index}`,
          kind: 'settle', rawCostActual: '0.00000000013', currency: 'USD',
        }, { prisma });
        const liability = await prisma.billingPaidUsageLiability.findUniqueOrThrow({
          where: { dispatchId },
        });
        expect(settled.debited_microcredits).toBe(liability.ratedMicrocredits.toString());
        expect(liability.billingMonth).toBe(inNovember ? '2026-11' : '2026-10');
        expect(liability.creditAccountId).toBe(ids.credit);
      };
      for (let index = 0; index < 4; index += 1) {
        await settleForward(400 + index, false, index % 2 === 1);
      }
      const late = await finalizePrepaidDispatch({ runtimeSecret: secret,
        dispatchId: 'dispatch-prepaid-300', receiptId: 'receipt-prepaid-300',
        kind: 'settle', rawCostActual: '0.00000000013', currency: 'USD' }, { prisma });
      expect(late.debited_microcredits).toBe('0');
      for (let index = 0; index < 8; index += 1) {
        await settleForward(404 + index, true, index % 2 === 0);
      }
      const liability = await prisma.billingPaidUsageLiability.aggregate({
        where: { creditAccountId: ids.credit }, _sum: { ratedMicrocredits: true },
      });
      const forwardRated = liability._sum.ratedMicrocredits ?? 0n;
      expect(forwardRated).toBeGreaterThan(0n);
      const old = await prisma.billingPrepaidRatingBucket.findUniqueOrThrow({
        where: { creditAccountId: ids.credit },
      });
      const forward = await prisma.billingPaidRatingBucket.findUniqueOrThrow({
        where: { ratingScopeKey: `prepaid:${ids.credit}` },
      });
      expect(forward.ratedMicrocredits).toBe(forwardRated);
      expect(old.debitedMicrocredits).toBe(2n);
      expect((await prisma.billingCreditAccount.findUniqueOrThrow({
        where: { id: ids.credit },
      })).balanceMicrocredits).toBe(opening - forwardRated);
      expect((await prisma.billingPaidUsageLiability.aggregate({
        where: { creditAccountId: ids.credit, billingMonth: '2026-11' },
        _sum: { ratedMicrocredits: true },
      }))._sum.ratedMicrocredits).toBe(forwardRated);
    } finally {
      await prisma.billingCreditBudgetCutover.update({ where: { id: 1 },
        data: { occurredAt: cutover.occurredAt } });
    }
  });

  it('registers a signed native run before spend and enforces a credit cap without historical guesses', async () => {
    const scope = { product: 'deepwater', organization_id: ids.org, team_id: ids.team,
      scope_type: 'run' as const, scope_id: 'run-pre-spend-budget',
      created_at: '2026-10-04T17:00:00.000Z', owner_sub: ids.user };
    const signActor = (audience: string, nativeScope?: typeof scope) => new SignJWT({
      product: 'deepwater', organisation_id: ids.org, team_id: ids.team,
      tv: 0, ...(nativeScope ? { native_scope: nativeScope } : {}),
    }).setProtectedHeader({ alg: 'RS256', kid: 'prepaid-test-key', typ: 'uoa-actor+jwt' })
      .setIssuer(issuer).setAudience(`${issuer}${audience}`).setSubject(ids.user)
      .setJti(`budget-${crypto.randomUUID()}`).setIssuedAt()
      .setExpirationTime('45s').sign(signingKey);
    const makeAuth = async (audience: string, nativeScope?: typeof scope) => ({
      credential: actorCredential, actorToken: await signActor(audience, nativeScope),
      request: { product: 'deepwater', organisationId: ids.org,
        teamId: ids.team, userId: ids.user },
    });
    const originalCutover = await prisma.billingCreditBudgetCutover.findUniqueOrThrow({
      where: { id: 1 },
    });
    await prisma.billingCreditBudgetCutover.update({ where: { id: 1 },
      data: { occurredAt: new Date('2026-10-04T16:00:00.000Z') } });
    try {
      await expect(registerNativeBudgetScope(
        await makeAuth('/billing/v1/credit-budgets/scopes'), scope, { prisma },
      )).rejects.toThrow('BUDGET_NATIVE_SCOPE_MISMATCH');
      expect(await registerNativeBudgetScope(
        await makeAuth('/billing/v1/credit-budgets/scopes', scope), scope, { prisma },
      )).toMatchObject({ status: 'registered', scope_id: scope.scope_id });
      expect(await registerNativeBudgetScope(
        await makeAuth('/billing/v1/credit-budgets/scopes', scope), scope, { prisma },
      )).toMatchObject({ status: 'registered' });
      const write = { product: scope.product, organization_id: scope.organization_id,
        team_id: scope.team_id, scope_type: scope.scope_type, scope_id: scope.scope_id,
        period: 'per_run' as const, mode: 'enforce' as const,
        limit_credits: '0.000001', warn_threshold_percent: 80,
        block_humans_when_over: false, degrade_model: null, degrade_provider: null };
      for (const mode of ['warn', 'degrade'] as const) {
        await expect(putCreditBudget(await makeAuth('/billing/v1/credit-budgets'),
          { ...write, mode }, { prisma })).rejects.toThrow('BUDGET_MODE_UNSUPPORTED');
      }
      expect(await prisma.billingCreditBudgetPolicy.count({ where: {
        product: scope.product, orgId: ids.org, scopeId: scope.scope_id,
      } })).toBe(0);
      const policy = await putCreditBudget(await makeAuth('/billing/v1/credit-budgets'),
        write, { prisma, now: new Date('2026-10-04T18:00:00.000Z'),
          proofDeps: { fetchProof: signedCurrentBudgetProof } });
      expect(policy).toMatchObject({ evidence_complete: true,
        spent_credits: '0', held_credits: '0', remaining_credits: '0.000001' });
      const listed = await listCreditBudgets(await makeAuth('/billing/v1/credit-budgets'),
        { prisma, now: new Date('2026-10-04T18:00:00.000Z'),
          proofDeps: { fetchProof: signedCurrentBudgetProof } });
      expect(listed.budgets).toEqual([expect.objectContaining({
        policy_id: policy.policy_id, scope_id: scope.scope_id,
      })]);
      const child = { ...scope, scope_id: 'run-child-pre-spend-budget',
        created_at: '2026-10-04T17:01:00.000Z' };
      await registerNativeBudgetScope(
        await makeAuth('/billing/v1/credit-budgets/scopes', child), child, { prisma });
      const admission = { requestFingerprint: 'a'.repeat(64),
        startedAt: new Date('2026-10-04T18:00:00.000Z'),
        product: 'deepwater', serviceId: ids.service, providerServiceId: 'openai',
        orgId: ids.org, teamId: ids.team, userId: ids.user, billingMonth: '2026-10',
        currency: 'USD', tariffId: ids.tariff, tariffMode: 'STANDARD' as const,
        markupBps: 0, paymentMode: 'PAY_AS_YOU_GO' as const,
        rawCostBound: new Prisma.Decimal('0.00000000013'), context: {
          contextId: 'ctx-child-pre-spend-budget', originProduct: 'deepwater',
          originSourceDomain: 'deepwater.example.com', projectId: null,
          runId: child.scope_id, runStartedAt: child.created_at, runOwnerSub: ids.user,
          budgetRunId: scope.scope_id, budgetRunStartedAt: scope.created_at,
          budgetRunOwnerSub: ids.user,
        } };
      await prisma.$transaction((tx) => reserveBudgetDispatch(tx, {
        ...admission, dispatchId: 'dispatch-child-first',
      }, { fetchProof: signedCurrentBudgetProof }));
      await expect(prisma.$transaction((tx) => reserveBudgetDispatch(tx, {
        ...admission, dispatchId: 'dispatch-child-over-cap',
      }, { fetchProof: signedCurrentBudgetProof }))).rejects.toThrow('BUDGET_CREDITS_EXHAUSTED');
      await expect(prisma.$transaction((tx) => reserveBudgetDispatch(tx, {
        ...admission, dispatchId: 'dispatch-child-wrong-birth',
        context: { ...admission.context, budgetRunStartedAt: child.created_at },
      }, { fetchProof: signedCurrentBudgetProof }))).rejects.toThrow('BUDGET_NATIVE_SCOPE_MISMATCH');
      await prisma.$transaction((tx) => releaseBudgetDispatch(tx, 'dispatch-child-first'));
      await expect(registerNativeBudgetScope(
        await makeAuth('/billing/v1/credit-budgets/scopes', {
          ...scope, created_at: '2026-10-04T17:01:00.000Z',
        }), { ...scope, created_at: '2026-10-04T17:01:00.000Z' }, { prisma },
      )).rejects.toThrow('BUDGET_NATIVE_SCOPE_CONFLICT');
    } finally {
      await prisma.billingCreditBudgetPolicy.deleteMany({ where: {
        product: scope.product, orgId: ids.org, scopeType: 'run', scopeId: scope.scope_id,
      } });
      await prisma.billingCreditBudgetNativeScope.deleteMany({ where: {
        product: scope.product, orgId: ids.org, scopeType: 'run',
        scopeId: { in: [scope.scope_id, 'run-child-pre-spend-budget'] },
      } });
      await prisma.billingCreditBudgetCutover.update({ where: { id: 1 },
        data: { occurredAt: originalCutover.occurredAt } });
    }
  });

  it('keeps a manager-created run cap owned by its captured run owner', async () => {
    const member = 'usr_prepaid_budget_member';
    const runId = 'run-manager-created-member-budget';
    const scope = { product: 'deepwater', organization_id: ids.org, team_id: ids.team,
      scope_type: 'run' as const, scope_id: runId,
      created_at: '2026-10-04T18:00:00.000Z', owner_sub: member };
    const auth = async (subject: string, endpoint: string, nativeScope?: typeof scope) => ({
      credential: actorCredential,
      actorToken: await new SignJWT({ product: 'deepwater', organisation_id: ids.org,
        team_id: ids.team, tv: 0,
        ...(nativeScope ? { native_scope: nativeScope } : {}) })
        .setProtectedHeader({ alg: 'RS256', kid: 'prepaid-test-key', typ: 'uoa-actor+jwt' })
        .setIssuer(issuer).setAudience(`${issuer}${endpoint}`).setSubject(subject)
        .setJti(`budget-${crypto.randomUUID()}`).setIssuedAt()
        .setExpirationTime('45s').sign(signingKey),
      request: { product: 'deepwater', organisationId: ids.org,
        teamId: ids.team, userId: subject },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`INSERT INTO users (id, email, user_key, name)
        VALUES (${member}, 'budget-member@example.com', 'budget-member@example.com', 'Budget Member')`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO org_members
        (id, org_id, user_id, domain, role, updated_at)
        VALUES ('org-member-budget', ${ids.org}, ${member}, 'prepaid.example.com', 'member', CURRENT_TIMESTAMP)`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO team_members
        (id, team_id, user_id, team_role, updated_at)
        VALUES ('team-member-budget', ${ids.team}, ${member}, 'member', CURRENT_TIMESTAMP)`);
    });
    try {
      for (const foreign of [
        { ...scope, product: 'deeptest' },
        { ...scope, organization_id: 'org_foreign' },
        { ...scope, team_id: 'team_foreign' },
      ]) {
        await expect(registerNativeBudgetScope(await auth(ids.user,
          '/billing/v1/credit-budgets/scopes', foreign), foreign, { prisma }))
          .rejects.toThrow('BUDGET_NATIVE_SCOPE_MISMATCH');
      }
      await expect(registerNativeBudgetScope(await auth(member,
        '/billing/v1/credit-budgets/scopes', { ...scope, owner_sub: ids.user }),
      { ...scope, owner_sub: ids.user }, { prisma }))
        .rejects.toThrow('BUDGET_RUN_OWNER_REQUIRED');
      await registerNativeBudgetScope(await auth(ids.user,
        '/billing/v1/credit-budgets/scopes', scope), scope, { prisma });
      await expect(registerNativeBudgetScope(await auth(ids.user,
        '/billing/v1/credit-budgets/scopes', { ...scope, owner_sub: ids.user }),
      { ...scope, owner_sub: ids.user }, { prisma }))
        .rejects.toThrow('BUDGET_NATIVE_SCOPE_CONFLICT');
      const write = { product: scope.product, organization_id: scope.organization_id,
        team_id: scope.team_id, scope_type: scope.scope_type, scope_id: scope.scope_id,
        period: 'per_run' as const, mode: 'enforce' as const,
        limit_credits: '1', warn_threshold_percent: 80,
        block_humans_when_over: true, degrade_model: null, degrade_provider: null };
      const policy = await putCreditBudget(await auth(ids.user,
        '/billing/v1/credit-budgets'), write, { prisma });
      expect((await prisma.billingCreditBudgetPolicy.findUniqueOrThrow({
        where: { id: policy.policy_id },
      })).ownerUserId).toBe(member);
      const listed = await listCreditBudgets(await auth(member,
        '/billing/v1/credit-budgets'), { prisma });
      expect(listed.budgets).toEqual([expect.objectContaining({
        policy_id: policy.policy_id, scope_id: runId,
      })]);
      const tightened = await putCreditBudget(await auth(member,
        '/billing/v1/credit-budgets'), { ...write, limit_credits: '0.5',
        expected_version: policy.version }, { prisma });
      expect(tightened.limit_credits).toBe('0.5');
      await expect(putCreditBudget(await auth(member,
        '/billing/v1/credit-budgets'), { ...write, limit_credits: '2',
        expected_version: tightened.version }, { prisma }))
        .rejects.toThrow('BUDGET_RUN_OWNER_REQUIRED');
    } finally {
      await prisma.billingCreditBudgetPolicy.deleteMany({ where: { scopeId: runId } });
      await prisma.billingCreditBudgetNativeScope.deleteMany({ where: { scopeId: runId } });
      await prisma.$executeRaw(Prisma.sql`DELETE FROM team_members WHERE user_id = ${member}`);
      await prisma.$executeRaw(Prisma.sql`DELETE FROM org_members WHERE user_id = ${member}`);
      await prisma.$executeRaw(Prisma.sql`DELETE FROM users WHERE id = ${member}`);
    }
  });
}
