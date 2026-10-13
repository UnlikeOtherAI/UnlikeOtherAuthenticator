import { BillingAssignmentScope, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { reserveBudgetDispatch } from '../../src/services/billing-credit-budget-dispatch.service.js';
import { readCycleCreditEvidence } from '../../src/services/billing-cycle-credit-evidence.service.js';
import { assertPrepaidUsageCovered } from '../../src/services/billing-prepaid-coverage.service.js';
import { finalizePrepaidDispatch, getLedgerDispatchDecision, reservePrepaidDispatch, } from '../../src/services/billing-prepaid-reservation.service.js';
import { admissionInput, beforeFinalAdmission, delegation, enabled, ids, prisma, reserveFixture, secret, setupPrepaidFixture } from '../helpers/prepaid-reservation-fixture.js';
import { registerCompanyBudgetCase, registerCumulativePaygBudgetCase, registerHistoricalBudgetProofCase, registerNativeRunBudgetCase, registerRunOwnerBudgetCase, registerUncappedNativeCase } from './billing-prepaid-budget.cases.js';

describe.skipIf(!enabled)('prepaid dispatch liability in PostgreSQL', () => {
  setupPrepaidFixture();

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

  registerHistoricalBudgetProofCase();

  registerUncappedNativeCase();

  registerCumulativePaygBudgetCase();

  registerCompanyBudgetCase();

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
          markup_bps, currency, usage_currency, usage_payment_mode)
        VALUES (${otherTariff}, ${otherService}, 'prepaid', 1, 'Prepaid', 'STANDARD',
          'NONE', 1000, 'USD', 'USD', 'PREPAID')`);
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

  registerNativeRunBudgetCase();

  registerRunOwnerBudgetCase();

  it('holds active credit, accepts trusted zero, and tombstones a lost request', async () => {
    await reserveFixture(99);
    const tariff = await prisma.billingTariff.findUniqueOrThrow({ where: { id: ids.tariff } });
    expect((await readCycleCreditEvidence(prisma, {
      orgId: ids.org, teamId: ids.team, serviceId: ids.service,
      billingMonth: '2026-10', payer: BillingAssignmentScope.TEAM,
      tariff, ratedAmount: '0.0000000013', rawLines: [{
        billingDisposition: 'paid', selectedProviderCost: '0.0000000013',
      }] as never,
    })).covered).toBe(false);
    await expect(assertPrepaidUsageCovered({
      usage: { billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
        scope: { organizationId: ids.org, teamId: ids.team, month: '2026-10' },
        lines: [{ billingProduct: 'deepwater', billingDisposition: 'paid',
          selectedProviderCost: '0.0000000013', currency: 'USD' }] } as never,
      serviceId: ids.service, product: 'deepwater', organisationId: ids.org,
      teamId: ids.team, billingMonth: '2026-10',
    }, prisma)).rejects.toThrow('PREPAID_RECEIPTS_UNRESOLVED');
    await expect(prisma.billingCreditAccount.update({ where: { id: ids.credit },
      data: { balanceMicrocredits: 0n } })).rejects.toThrow();
    const zero = await finalizePrepaidDispatch({ runtimeSecret: secret,
      dispatchId: 'dispatch-prepaid-99', receiptId: 'receipt-prepaid-zero',
      kind: 'settle', rawCostActual: '0', currency: 'USD' }, { prisma });
    expect(zero.debited_microcredits).toBe('0');
    const released = await finalizePrepaidDispatch({ runtimeSecret: secret,
      dispatchId: 'dispatch-prepaid-lost', receiptId: 'receipt-no-egress',
      kind: 'release' }, { prisma });
    expect(released.status).toBe('RELEASED');
    expect((await getLedgerDispatchDecision({ runtimeSecret: secret,
      dispatchId: 'dispatch-prepaid-lost' }, { prisma })).payment_mode).toBe('cancelled');
    await expect(finalizePrepaidDispatch({ runtimeSecret: secret,
      dispatchId: 'dispatch-prepaid-lost', receiptId: 'different',
      kind: 'release' }, { prisma })).rejects.toThrow('PREPAID_RECEIPT_CONFLICT');
  });

  it('never debits raw provider cost through an existing free tariff reservation', async () => {
    const freeTariffId = 'tariff_prepaid_free';
    await prisma.$executeRaw(Prisma.sql`INSERT INTO "billing_tariffs"
      ("id", "service_id", "key", "version", "name", "mode", "collection_mode",
       "markup_bps", "currency", "usage_currency", "usage_payment_mode")
      VALUES (${freeTariffId}, ${ids.service}, 'free', 1, 'Free', 'FREE',
        'NONE', 0, 'USD', 'USD', 'PREPAID')`);
    await reserveFixture(100, '0.01', freeTariffId, 0n);
    const before = (await prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.credit },
    })).balanceMicrocredits;
    const result = await finalizePrepaidDispatch({ runtimeSecret: secret,
      dispatchId: 'dispatch-prepaid-100', receiptId: 'receipt-prepaid-free',
      kind: 'settle', rawCostActual: '0.01', currency: 'USD' }, { prisma });
    expect(result).toMatchObject({ status: 'SETTLED', debited_microcredits: '0' });
    expect((await prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.credit },
    })).balanceMicrocredits).toBe(before);
  });

  it('requires real signed exact-product authority and rejects an immutable replay after epoch revocation', async () => {
    const input = admissionInput('dispatch-auth-replay');
    const token = await delegation();
    const deps = { prisma, now: new Date(input.dispatchStartedAt) };
    await expect(reservePrepaidDispatch({ runtimeSecret: secret,
      delegation: await delegation({ product: 'nessie' }), input }, deps))
      .rejects.toThrow('PREPAID_DELEGATION_MISMATCH');
    const first = await reservePrepaidDispatch({ runtimeSecret: secret, delegation: token, input }, deps);
    expect(first.payment_mode).toBe('prepaid');
    expect(first.reserved_microcredits).toBe('10');
    expect(first.context_digest).toMatch(/^[a-f0-9]{64}$/);
    expect((await getLedgerDispatchDecision({ runtimeSecret: secret,
      dispatchId: input.dispatchId }, { prisma })).context_digest)
      .toBe(first.context_digest);
    await prisma.user.update({ where: { id: ids.user }, data: { tokenVersion: 1 } });
    await expect(reservePrepaidDispatch({ runtimeSecret: secret, delegation: token, input }, deps))
      .rejects.toThrow('PREPAID_SUBJECT_NOT_ENTITLED');
    await prisma.user.update({ where: { id: ids.user }, data: { tokenVersion: 0 } });
    await finalizePrepaidDispatch({ runtimeSecret: secret, dispatchId: input.dispatchId,
      receiptId: 'no-dispatch-auth-replay', kind: 'release' }, { prisma });
  });

  it('refuses both new admission and replay after current team membership revocation', async () => {
    const input = admissionInput('dispatch-member-replay');
    const token = await delegation();
    const deps = { prisma, now: new Date(input.dispatchStartedAt) };
    await reservePrepaidDispatch({ runtimeSecret: secret, delegation: token, input }, deps);
    await prisma.teamMember.update({ where: { id: 'team-member-prepaid' }, data: { status: 'REMOVED' } });
    for (const dispatchId of [input.dispatchId, 'dispatch-member-new']) {
      await expect(reservePrepaidDispatch({ runtimeSecret: secret,
        delegation: token, input: { ...input, dispatchId } }, deps))
        .rejects.toThrow('PREPAID_SUBJECT_NOT_ENTITLED');
    }
    await prisma.teamMember.update({ where: { id: 'team-member-prepaid' }, data: { status: 'ACTIVE' } });
    await finalizePrepaidDispatch({ runtimeSecret: secret, dispatchId: input.dispatchId,
      receiptId: 'no-dispatch-member-replay', kind: 'release' }, { prisma });
  });

  it('rechecks the credential epoch after resolving the credit account', async () => {
    const guarded = beforeFinalAdmission(() => prisma.user.update({
      where: { id: ids.user }, data: { tokenVersion: 1 },
    }));
    const input = admissionInput('dispatch-revoked-between-admission-steps');
    try {
      await expect(reservePrepaidDispatch({ runtimeSecret: secret,
        delegation: await delegation(), input },
      { prisma: guarded.prisma, now: new Date(input.dispatchStartedAt) }))
        .rejects.toThrow('PREPAID_SUBJECT_NOT_ENTITLED');
      expect(guarded.count()).toBeGreaterThanOrEqual(3);
      expect(await prisma.billingPrepaidReservation.findUnique({
        where: { dispatchId: input.dispatchId },
      })).toBeNull();
    } finally {
      await prisma.user.update({ where: { id: ids.user }, data: { tokenVersion: 0 } });
    }
  });

  it('serializes concurrent admissions without overspending the shared pool', async () => {
    const token = await delegation();
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => {
      const input = admissionInput(`dispatch-concurrent-${index}`);
      return reservePrepaidDispatch({ runtimeSecret: secret, delegation: token, input },
        { prisma, now: new Date(input.dispatchStartedAt) });
    }));
    const successful = attempts.filter((attempt) => attempt.status === 'fulfilled');
    expect(successful.length).toBe(9);
    for (const attempt of attempts) {
      if (attempt.status === 'rejected') expect(String(attempt.reason)).toContain('PREPAID_CREDIT_EXHAUSTED');
    }
    const held = await prisma.billingPrepaidReservation.aggregate({
      where: { creditAccountId: ids.credit, status: 'ACTIVE' }, _sum: { reservedMicrocredits: true },
    });
    expect(held._sum.reservedMicrocredits).toBe(90n);
    for (const attempt of successful) {
      if (attempt.status !== 'fulfilled') continue;
      await finalizePrepaidDispatch({ runtimeSecret: secret, dispatchId: attempt.value.dispatch_id,
        receiptId: `unsent-${attempt.value.dispatch_id}`, kind: 'release' }, { prisma });
    }
  });

  it('refuses a runtime key revoked between the two admission transactions', async () => {
    const guarded = beforeFinalAdmission(() => prisma.billingLedgerRuntimeKey.update({
      where: { id: ids.key }, data: { revokedAt: new Date() },
    }));
    const input = admissionInput('dispatch-runtime-key-revoked');
    await expect(reservePrepaidDispatch({ runtimeSecret: secret,
      delegation: await delegation(), input },
    { prisma: guarded.prisma, now: new Date(input.dispatchStartedAt) }))
      .rejects.toThrow('INVALID_LEDGER_RUNTIME_KEY');
    expect(guarded.count()).toBeGreaterThanOrEqual(3);
    expect(await prisma.billingPrepaidReservation.findUnique({
      where: { dispatchId: input.dispatchId },
    })).toBeNull();
  });
});
