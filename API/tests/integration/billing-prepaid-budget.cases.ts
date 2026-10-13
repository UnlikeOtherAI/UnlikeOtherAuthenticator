import { Prisma } from '@prisma/client';
import { CompactSign, createLocalJWKSet, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { proveHistoricalBudgetScope } from '../../src/services/billing-credit-budget-baseline.service.js';
import { budgetScopeTotals, releaseBudgetDispatch, reserveBudgetDispatch } from '../../src/services/billing-credit-budget-dispatch.service.js';
import { listCreditBudgets, putCreditBudget, registerNativeBudgetScope } from '../../src/services/billing-credit-budget-management.service.js';
import { verifyLedgerBudgetReceiptSet, type BudgetReceiptScope } from '../../src/services/billing-ledger-paid-receipt-proof.service.js';
import { recordPaidUsageLiability } from '../../src/services/billing-paid-liability.service.js';
import { actorCredential, ids, issuer, prisma, signedCurrentBudgetProof, signingKey } from '../helpers/prepaid-reservation-fixture.js';

export function registerHistoricalBudgetProofCase() {
  it('backfills frozen prepaid history only under an exact signed budget cohort', async () => {
    const startedAt = new Date('2026-09-09T12:00:00.000Z');
    const dispatchId = 'dispatch-prepaid-historical-proof';
    const receiptId = 'receipt-prepaid-historical-proof';
    const reservation = await prisma.billingPrepaidReservation.create({ data: {
      dispatchId, requestFingerprint: 'f'.repeat(64), receiptId,
      creditAccountId: ids.credit, tariffId: ids.tariff, serviceId: ids.service,
      providerServiceId: 'openai', appKeyId: ids.key, orgId: ids.org,
      teamId: ids.team, userId: ids.user, billingMonth: '2026-09',
      dispatchStartedAt: startedAt, currency: 'USD', rawCostBound: '0.000000001',
      reservedMicrocredits: 2n, rawCostActual: '0.00000000013',
      debitedMicrocredits: 1n, status: 'SETTLED', terminalAt: startedAt,
    } });
    const scope = { product: 'deepwater', organisationId: ids.org,
      teamId: ids.team, billingMonth: '2026-09' };
    const digest = createHash('sha256').update('ledger-budget-receipt-set-v1:paid\n')
      .update(JSON.stringify([dispatchId, receiptId, '0.000000000130000000']) + '\n')
      .digest('hex');
    const body = { contract: 'ledger-budget-receipt-set-v1',
      scope: { billing_product: scope.product, organization_id: scope.organisationId,
        team_id: scope.teamId, billing_month: scope.billingMonth },
      snapshot: { cursor: `mpr_${'c'.repeat(32)}`,
        captured_at: '2026-10-04T19:00:00.000Z', immutable: true },
      paid_receipt_count: '1', paid_receipt_sha256: digest,
      zero_incremental_count: '0', zero_incremental_sha256: createHash('sha256')
        .update('ledger-budget-receipt-set-v1:zero\n').digest('hex'),
      pending_dispatch_count: '0', pending_dispatch_sha256: createHash('sha256')
        .update('ledger-budget-receipt-set-v1:pending\n').digest('hex'),
      unresolved_paid_attempts: '0' };
    const signature = await new CompactSign(Buffer.from(JSON.stringify(body)))
      .setProtectedHeader({ alg: 'RS256', typ: 'ledger-budget-receipt-set+jws',
        kid: 'prepaid-test-key' }).sign(signingKey);
    const keys = createLocalJWKSet({ keys: [actorCredential.actorPublicJwk] });
    const proof = await verifyLedgerBudgetReceiptSet({ ...body, signature }, scope, keys);
    const budgetScope = { product: scope.product, orgId: ids.org, teamId: ids.team,
      scopeType: 'team', scopeId: ids.team };
    const prove = () => prisma.$transaction((tx) => proveHistoricalBudgetScope(tx,
      budgetScope, new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-10-01T00:00:00.000Z'),
      { fetchProof: async () => proof }));
    expect(await prove()).toBe(true);
    expect(await prove()).toBe(true);
    expect(await prisma.billingCreditBudgetLegacyLiability.findUniqueOrThrow({
      where: { dispatchId },
    })).toMatchObject({ receiptId, sourceId: reservation.id,
      ratedMicrocredits: 1n, sourceType: 'prepaid_wallet_debit' });
    expect(await prisma.billingCreditBudgetDispatch.findUniqueOrThrow({
      where: { dispatchId },
    })).toMatchObject({ isLegacy: true, status: 'SETTLED' });
    const totals = await prisma.$transaction((tx) => budgetScopeTotals(tx,
      budgetScope, 'monthly', new Date('2026-09-20T00:00:00.000Z'),
      { fetchProof: async () => proof }));
    expect(totals).toMatchObject({ spent: 1n, held: 0n, unknown: 0n,
      historicalComplete: true });
    const empty = { ...proof, paid_receipt_count: '0',
      paid_receipt_sha256: createHash('sha256')
        .update('ledger-budget-receipt-set-v1:paid\n').digest('hex') };
    expect(await prisma.$transaction((tx) => proveHistoricalBudgetScope(tx,
      budgetScope, new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-10-01T00:00:00.000Z'),
      { fetchProof: async () => empty }))).toBe(false);
  });
}

export function registerUncappedNativeCase() {
  it('does not require native registration for an unrelated uncapped project', async () => {
    const policy = await prisma.billingCreditBudgetPolicy.create({ data: {
      product: 'deepwater', orgId: ids.org, teamId: ids.team,
      scopeType: 'project', scopeId: 'capped-project-A', period: 'monthly',
      mode: 'enforce', limitMicrocredits: 1_000_000n, warnThresholdPercent: 80,
      blockHumansWhenOver: true,
    } });
    const input = { dispatchId: 'dispatch-uncapped-project-B',
      requestFingerprint: 'd'.repeat(64), startedAt: new Date('2026-10-04T18:00:00.000Z'),
      product: 'deepwater', serviceId: ids.service, providerServiceId: 'openai',
      orgId: ids.org, teamId: ids.team, userId: ids.user, billingMonth: '2026-10',
      currency: 'USD', tariffId: ids.tariff, tariffMode: 'STANDARD' as const,
      markupBps: 0, paymentMode: 'PAY_AS_YOU_GO' as const,
      rawCostBound: new Prisma.Decimal('0.00000000013'), context: {
        contextId: 'verified-project-B', originProduct: 'deepwater',
        originSourceDomain: 'deepwater.example.com', projectId: 'uncapped-project-B',
        runId: null,
      } };
    try {
      await expect(prisma.$transaction((tx) => reserveBudgetDispatch(tx, input)))
        .resolves.toMatchObject({ dispatchId: input.dispatchId });
      await expect(prisma.$transaction((tx) => reserveBudgetDispatch(tx, {
        ...input, dispatchId: 'dispatch-project-context-missing',
        context: { ...input.context, projectId: null },
      }))).rejects.toThrow('BUDGET_CONTEXT_INCOMPLETE');
      await expect(prisma.$transaction((tx) => reserveBudgetDispatch(tx, {
        ...input, dispatchId: 'dispatch-capped-native-missing',
        context: { ...input.context, projectId: 'capped-project-A' },
      }))).rejects.toThrow('BUDGET_NATIVE_SCOPE_MISMATCH');
      await prisma.$transaction((tx) => releaseBudgetDispatch(tx, input.dispatchId));
    } finally {
      await prisma.billingCreditBudgetPolicy.delete({ where: { id: policy.id } });
    }
  });
}

export function registerCumulativePaygBudgetCase() {
  it('projects one cumulative-rated PAYG liability into a finite team cap', async () => {
    const originalCutover = await prisma.billingCreditBudgetCutover.findUniqueOrThrow({
      where: { id: 1 },
    });
    await prisma.billingCreditBudgetCutover.update({ where: { id: 1 },
      data: { occurredAt: new Date('2026-10-01T00:00:00.000Z') } });
    const policy = await prisma.billingCreditBudgetPolicy.create({ data: {
      product: 'deepwater', orgId: ids.org, teamId: ids.team,
      scopeType: 'team', scopeId: ids.team, period: 'monthly', mode: 'enforce',
      limitMicrocredits: 12n, warnThresholdPercent: 80,
      blockHumansWhenOver: true, degradeModel: null, degradeProvider: null,
    } });
    try {
      for (let index = 0; index < 10; index += 1) {
        const dispatchId = `dispatch-forward-${index}`;
        const startedAt = new Date('2026-10-04T18:00:00.000Z');
        await prisma.$transaction(async (tx) => {
          await reserveBudgetDispatch(tx, { dispatchId,
            requestFingerprint: 'a'.repeat(64), startedAt,
            product: 'deepwater', serviceId: ids.service, providerServiceId: 'openai',
            orgId: ids.org, teamId: ids.team, userId: ids.user,
            billingMonth: '2026-10', currency: 'USD', tariffId: ids.tariff,
            tariffMode: 'STANDARD', markupBps: 0, paymentMode: 'PAY_AS_YOU_GO',
            rawCostBound: new Prisma.Decimal('0.00000000013'),
            context: { contextId: `ctx-${index}`, originProduct: 'deepwater',
              originSourceDomain: 'deepwater.example.com', projectId: null, runId: null },
          }, { fetchProof: signedCurrentBudgetProof });
          await recordPaidUsageLiability(tx, { dispatchId,
            receiptId: `receipt-forward-${index}`,
            actual: new Prisma.Decimal('0.00000000013') });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      }
      const forward = await prisma.billingPaidUsageLiability.aggregate({
        _sum: { ratedMicrocredits: true },
      });
      expect(forward._sum.ratedMicrocredits).toBe(2n);
      expect((await prisma.billingPaidRatingBucket.findUniqueOrThrow({ where: {
        ratingScopeKey: `payg:${createHash('sha256').update(JSON.stringify([
          ids.org, ids.team, 'USD',
        ])).digest('hex')}`,
      } })).ratedMicrocredits).toBe(2n);
      const totals = await prisma.$transaction((tx) => budgetScopeTotals(tx, {
        product: 'deepwater', orgId: ids.org, teamId: ids.team,
        scopeType: 'team', scopeId: ids.team,
      }, 'monthly', new Date('2026-10-04T18:00:00.000Z'),
      { fetchProof: signedCurrentBudgetProof }));
      expect(totals.spent).toBe(4n); // Two already charged legacy credits + two forward.
      await prisma.billingCreditBudgetPolicy.update({ where: { id: policy.id },
        data: { limitMicrocredits: 4n, version: { increment: 1 } } });
      await expect(prisma.$transaction((tx) => reserveBudgetDispatch(tx, {
        dispatchId: 'dispatch-forward-denied',
        requestFingerprint: 'a'.repeat(64),
        startedAt: new Date('2026-10-04T18:00:00.000Z'),
        product: 'deepwater', serviceId: ids.service, providerServiceId: 'openai',
        orgId: ids.org, teamId: ids.team, userId: ids.user,
        billingMonth: '2026-10', currency: 'USD', tariffId: ids.tariff,
        tariffMode: 'STANDARD', markupBps: 0, paymentMode: 'PAY_AS_YOU_GO',
        rawCostBound: new Prisma.Decimal('0.00000000013'), context: null,
      }, { fetchProof: signedCurrentBudgetProof }))).rejects.toThrow('BUDGET_CREDITS_EXHAUSTED');
    } finally {
      await prisma.billingCreditBudgetPolicy.delete({ where: { id: policy.id } });
      await prisma.billingCreditBudgetCutover.update({ where: { id: 1 },
        data: { occurredAt: originalCutover.occurredAt } });
    }
  }, 90_000);
}

export function registerCompanyBudgetCase() {
  it('proves an organization cap once per month across two teams', async () => {
    const secondTeam = 'team_prepaid_rating_other';
    const policy = await prisma.billingCreditBudgetPolicy.create({ data: {
      product: 'deepwater', orgId: ids.org, teamId: null,
      scopeType: 'organization', scopeId: ids.org, period: 'monthly',
      mode: 'enforce', limitMicrocredits: 1_000_000n,
      warnThresholdPercent: 80, blockHumansWhenOver: true,
      degradeModel: null, degradeProvider: null,
    } });
    const seen: BudgetReceiptScope[] = [];
    const fetchProof = async (scope: BudgetReceiptScope) => {
      seen.push(scope);
      return signedCurrentBudgetProof(scope);
    };
    const startedAt = new Date('2026-10-04T19:00:00.000Z');
    const input = { requestFingerprint: 'a'.repeat(64), startedAt,
      product: 'deepwater', serviceId: ids.service, providerServiceId: 'openai',
      orgId: ids.org, userId: ids.user, billingMonth: '2026-10',
      currency: 'USD', tariffId: ids.tariff, tariffMode: 'STANDARD' as const,
      markupBps: 0, paymentMode: 'PAY_AS_YOU_GO' as const,
      rawCostBound: new Prisma.Decimal('0.00000000013'), context: null };
    try {
      await prisma.$transaction((tx) => reserveBudgetDispatch(tx, {
        ...input, dispatchId: 'dispatch-org-team-one', teamId: ids.team,
      }, { fetchProof }));
      await prisma.$transaction((tx) => reserveBudgetDispatch(tx, {
        ...input, dispatchId: 'dispatch-org-team-two', teamId: secondTeam,
      }, { fetchProof }));
      expect(seen).toEqual([
        expect.objectContaining({ budgetScopeType: 'organization', teamId: null,
          excludeTeamId: ids.team }),
        expect.objectContaining({ budgetScopeType: 'organization', teamId: null,
          excludeTeamId: secondTeam }),
      ]);
      const totals = await prisma.$transaction((tx) => budgetScopeTotals(tx, {
        product: 'deepwater', orgId: ids.org, teamId: ids.team,
        scopeType: 'organization', scopeId: ids.org,
      }, 'monthly', startedAt, { fetchProof }));
      expect(totals.historicalComplete).toBe(true);
      expect(totals.held).toBeGreaterThanOrEqual(2n);
    } finally {
      await prisma.$transaction(async (tx) => {
        await releaseBudgetDispatch(tx, 'dispatch-org-team-one');
        await releaseBudgetDispatch(tx, 'dispatch-org-team-two');
      });
      await prisma.billingCreditBudgetPolicy.delete({ where: { id: policy.id } });
    }
  });
}

export function registerNativeRunBudgetCase() {
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
}

export function registerRunOwnerBudgetCase() {
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
