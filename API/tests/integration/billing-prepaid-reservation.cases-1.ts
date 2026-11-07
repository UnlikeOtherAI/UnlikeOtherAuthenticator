import { createHash } from 'node:crypto';
import { BillingAssignmentScope, Prisma } from '@prisma/client';
import { CompactSign, createLocalJWKSet } from 'jose';
import { expect, it } from 'vitest';
import { finalizePrepaidDispatch } from '../../src/services/billing-prepaid-reservation.service.js';
import { assertPrepaidUsageCovered } from '../../src/services/billing-prepaid-coverage.service.js';
import { readCycleCreditEvidence } from '../../src/services/billing-cycle-credit-evidence.service.js';

import { budgetScopeTotals, releaseBudgetDispatch, reserveBudgetDispatch } from '../../src/services/billing-credit-budget-dispatch.service.js';
import { recordPaidUsageLiability } from '../../src/services/billing-paid-liability.service.js';

import { proveHistoricalBudgetScope } from '../../src/services/billing-credit-budget-baseline.service.js';
import { verifyLedgerBudgetReceiptSet, type BudgetReceiptScope } from '../../src/services/billing-ledger-paid-receipt-proof.service.js';
import { ids, secret, prisma, signingKey, actorCredential, signedCurrentBudgetProof, reserveFixture } from './billing-prepaid-reservation.suite-fixture.js';

export function registerCases1() {
  it('carries tiny exact costs across receipts and debits only the cumulative delta', async () => {
    for (let index = 0; index < 10; index += 1) {
      await reserveFixture(index);
      const result = await finalizePrepaidDispatch({ runtimeSecret: secret,
        dispatchId: `dispatch-prepaid-${index}`, receiptId: `receipt-prepaid-${index}`,
        kind: 'settle', rawCostActual: '0.00000000013', currency: 'USD' }, { prisma });
      expect(result.status).toBe('SETTLED');
      expect(result.debited_microcredits).toBe(index === 0 || index === 7 ? '1' : '0');
    }
    const bucket = await prisma.billingPrepaidRatingBucket.findUniqueOrThrow({
      where: { creditAccountId: ids.credit },
    });
    expect(bucket.cumulativeRatedQuanta.toFixed(0)).toBe('13000000000000');
    expect(bucket.debitedMicrocredits).toBe(2n);
    expect((await prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.credit },
    })).balanceMicrocredits).toBe(98n);
    expect(await prisma.billingCreditEntry.count({
      where: { creditAccountId: ids.credit, sourceType: 'prepaid_provider_receipt' },
    })).toBe(2);
    const tariff = await prisma.billingTariff.findUniqueOrThrow({ where: { id: ids.tariff } });
    const creditEvidence = await readCycleCreditEvidence(prisma, {
      orgId: ids.org, teamId: ids.team, serviceId: ids.service,
      billingMonth: '2026-10', payer: BillingAssignmentScope.TEAM,
      tariff, ratedAmount: '0.0000000013', rawLines: [{
        billingDisposition: 'paid', selectedProviderCost: '0.0000000013',
      }] as never,
    });
    expect(creditEvidence).toMatchObject({ covered: true,
      consumed_microcredits: '2', funded_debit_microcredits: '2' });
    await expect(assertPrepaidUsageCovered({
      usage: { billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
        scope: { organizationId: ids.org, teamId: ids.team, month: '2026-10' },
        lines: [{ billingProduct: 'deepwater', billingDisposition: 'paid',
          selectedProviderCost: '0.0000000013', currency: 'USD' }] } as never,
      serviceId: ids.service, product: 'deepwater', organisationId: ids.org,
      teamId: ids.team, billingMonth: '2026-10',
    }, prisma)).resolves.toBeUndefined();
    const replay = await finalizePrepaidDispatch({ runtimeSecret: secret,
      dispatchId: 'dispatch-prepaid-0', receiptId: 'receipt-prepaid-0',
      kind: 'settle', rawCostActual: '0.00000000013', currency: 'USD' }, { prisma });
    expect(replay.debited_microcredits).toBe('1');
    expect(await prisma.billingPaidUsageLiability.count()).toBe(0);
    expect((await prisma.billingCreditBudgetLegacyLiability.aggregate({
      _sum: { ratedMicrocredits: true },
    }))._sum.ratedMicrocredits).toBe(2n);
  });

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
  });

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
