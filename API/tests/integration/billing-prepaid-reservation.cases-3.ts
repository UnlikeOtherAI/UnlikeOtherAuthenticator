import { BillingAssignmentScope, Prisma } from '@prisma/client';

import { expect, it } from 'vitest';
import { finalizePrepaidDispatch, getLedgerDispatchDecision, reservePrepaidDispatch } from '../../src/services/billing-prepaid-reservation.service.js';
import { assertPrepaidUsageCovered } from '../../src/services/billing-prepaid-coverage.service.js';
import { readCycleCreditEvidence } from '../../src/services/billing-cycle-credit-evidence.service.js';

import { ids, secret, prisma, delegation, admissionInput, beforeFinalAdmission, reserveFixture } from './billing-prepaid-reservation.suite-fixture.js';

export function registerCases3() {
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
       "markup_bps", "currency", "usage_payment_mode")
      VALUES (${freeTariffId}, ${ids.service}, 'free', 1, 'Free', 'FREE',
        'NONE', 0, 'USD', 'PREPAID')`);
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
}
