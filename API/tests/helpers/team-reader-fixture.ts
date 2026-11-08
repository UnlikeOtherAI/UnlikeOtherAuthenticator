import { Prisma, type PrismaClient } from '@prisma/client';
import { reserveBudgetDispatch } from '../../src/services/billing-credit-budget-dispatch.service.js';
import { recordPaidUsageLiability } from '../../src/services/billing-paid-liability.service.js';

/** Actual forward capture/rating plus explicit pre-cutover imported snapshots.
 * All services under test read with current guards enabled. No provider call. */
export async function seedTeamReaderRecords(db: PrismaClient) {
  const month = new Date().toISOString().slice(0, 7);
  const epoch = (await db.billingOrganisationScopeCutover.findUniqueOrThrow({ where: { id: 1 } })).activatedAt;
  await db.billingTariff.create({ data: { id: 'reader-tariff', serviceId: 'control-service', key: 'reader',
    version: 1, name: 'Recorded usage', mode: 'CUSTOM', collectionMode: 'MANUAL', currency: 'USD',
    markupBps: 0, monthlyAmountMinor: 0n } });
  await db.$transaction(async tx => {
    await reserveBudgetDispatch(tx, { dispatchId: 'reader-live', requestFingerprint: 'c'.repeat(64), startedAt: new Date(),
      product: 'nessie', serviceId: 'control-service', providerServiceId: 'synthetic-provider', orgId: 'control-org',
      teamId: 'addon-other-team', userId: 'control-owner', billingMonth: month, currency: 'USD', tariffId: 'reader-tariff',
      tariffMode: 'CUSTOM', markupBps: 0, paymentMode: 'PAY_AS_YOU_GO', rawCostBound: new Prisma.Decimal('0.1'), context: null });
    await recordPaidUsageLiability(tx, { dispatchId: 'reader-live', receiptId: 'reader-live-receipt', actual: new Prisma.Decimal('0.1') });
  });
  await db.billingStripeAccount.create({ data: { id: 'reader-other-test', stripeAccountId: 'acct_HistoricalReader', livemode: false } });
  // These immutable historical rows predate this test's installed scope epoch.
  // Import is fixture setup, never an allowed migration or financial write path.
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role=replica');
    for (const [suffix, accountId, teamId, balance] of [
      ['test', 'control-test', 'addon-other-team', 500000000n],
      ['other-test', 'reader-other-test', 'addon-other-team', 700000000n],
      ['other-team', 'control-test', 'control-team', 99000000000n],
    ] as const) {
      await tx.billingStripeCustomer.create({ data: { id: `reader-customer-${suffix}`, accountId, orgId: 'control-org',
        teamId, scope: 'TEAM', scopeKey: `control-org:${teamId}`, stripeCustomerId: `cus_reader_${suffix}` } });
      await tx.billingCreditAccount.create({ data: { id: `reader-wallet-${suffix}`, accountId,
        customerId: `reader-customer-${suffix}`, orgId: 'control-org', teamId, scope: 'TEAM',
        scopeKey: `control-org:${teamId}`, balanceMicrocredits: balance, createdAt: new Date(epoch.getTime() - 1000) } });
    }
    for (const [suffix, accountId, cost, rated] of [
      ['test', 'control-test', '0.2', 200000000n], ['other-test', 'reader-other-test', '0.3', 300000000n],
    ] as const) {
      await tx.billingCreditBudgetDispatch.create({ data: { dispatchId: `reader-${suffix}`, billingAccountId: accountId,
        contextDigest: 'd'.repeat(64), serviceId: 'control-service', providerServiceId: 'synthetic-provider', orgId: 'control-org',
        teamId: 'addon-other-team', userId: 'control-owner', billingMonth: month, currency: 'USD', tariffId: 'reader-tariff',
        frozenMarkupBps: 0, tariffMode: 'CUSTOM', paymentMode: 'PAY_AS_YOU_GO', status: 'SETTLED',
        createdAt: new Date(epoch.getTime() - 1000), terminalAt: new Date(epoch.getTime() - 500) } });
      await tx.billingPaidUsageLiability.create({ data: { dispatchId: `reader-${suffix}`, receiptId: `reader-${suffix}-receipt`,
        serviceId: 'control-service', providerServiceId: 'synthetic-provider', orgId: 'control-org', teamId: 'addon-other-team',
        userId: 'control-owner', billingMonth: month, currency: 'USD', tariffId: 'reader-tariff', frozenMarkupBps: 0,
        paymentMode: 'PAY_AS_YOU_GO', rawCostActual: cost, ratedQuanta: '0', ratedMicrocredits: rated } });
    }
  });
}
