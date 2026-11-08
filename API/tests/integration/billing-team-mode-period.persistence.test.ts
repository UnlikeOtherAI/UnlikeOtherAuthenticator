import { type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertBillingPeriodMode } from '../../src/services/billing-mode-period.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { createSettlement, deferred, ids, seedAdoption } from './billing-team-mode-adoption.fixture.js';
import { settleCreditPortfolio } from '../../src/services/billing-credit-settlement.service.js';
import { seed as seedCredit, ids as creditIds, deepwaterCredential, portfolio }
  from './billing-credit-settlement.suite-fixture.js';

describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS !== 'true')('monthly provider-account isolation', () => {
  let db: PrismaClient; let cleanup: () => Promise<void>; let month: string; let nextMonth: string;
  const sourceCreatedAt = new Date('2020-01-01');
  const check = (tx: Parameters<typeof assertBillingPeriodMode>[0], accountId: string, billingMonth = month) =>
    assertBillingPeriodMode(tx, { accountId, orgId: ids.org, teamId: ids.team, month: billingMonth, sourceCreatedAt });
  beforeAll(async () => {
    const handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL required');
    db = handle.prisma; cleanup = handle.cleanup; await seedAdoption(db,true);
    const epoch = await db.billingModeCutover.findUniqueOrThrow({ where: { id: 1 } });
    const future = new Date(Date.UTC(epoch.activatedAt.getUTCFullYear(), epoch.activatedAt.getUTCMonth() + 1));
    month = future.toISOString().slice(0, 7);
    nextMonth = new Date(Date.UTC(future.getUTCFullYear(), future.getUTCMonth() + 1)).toISOString().slice(0, 7);
    await db.billingStripeAccount.create({ data: { id: 'replacement-live', stripeAccountId: 'acct_replacementLive', livemode: true } });
  });
  afterAll(async () => { await cleanup?.(); });

  it('holds an installation exactly at UTC month-start, inclusively', async () => {
    const epoch = await db.billingModeCutover.findUniqueOrThrow({ where: { id: 1 } });
    const start = new Date(epoch.activatedAt.toISOString().slice(0, 7) + '-01T00:00:00.000Z');
    // Fixture construction only: emulate installation at the exact boundary.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.billingModeCutover.update({ where: { id: 1 }, data: { activatedAt: start } });
    });
    await expect(check(db, 'adoption-live', start.toISOString().slice(0, 7)))
      .rejects.toThrow('BILLING_MODE_TRANSITION_RECONCILIATION_REQUIRED');
    await expect(check(db, 'adoption-live')).resolves.toBeUndefined();
  });

  it('refuses a second LIVE account after a post-cutover credit settlement, including organisation overlap', async () => {
    await createSettlement(db, month);
    await expect(check(db, 'replacement-live')).rejects.toThrow('BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH');
    await expect(assertBillingPeriodMode(db, { accountId: 'replacement-live', orgId: ids.org,
      teamId: null, month, sourceCreatedAt })).rejects.toThrow('BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH');
    await expect(check(db, 'adoption-live')).resolves.toBeUndefined();
  });

  it('serializes competing same-mode account collection before either captures the month', async () => {
    const selected = deferred(); const release = deferred();
    const first = db.$transaction(async (tx) => {
      await check(tx, 'adoption-live', nextMonth); selected.resolve(); await release.promise;
      await createSettlement(tx, nextMonth);
    }, { timeout: 10_000 });
    await selected.promise;
    const second = db.$transaction(async (tx) => { await check(tx, 'replacement-live', nextMonth); })
      .then(() => 'unexpected success', (error: Error) => error.message);
    try {
      for (let n = 0; n < 100; n++) {
        const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%assert_billing_period_mode%') AS waiting`;
        if (rows[0]?.waiting) break;
        if (n === 99) throw new Error('Second collector did not wait');
        await new Promise((done) => setTimeout(done, 10));
      }
    } finally { release.resolve(); }
    await first;
    expect(await second).toContain('BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH');
  });

  it('refuses a second LIVE account after an export reservation in a later month', async () => {
    const billingMonth = new Date(nextMonth + '-01T00:00:00.000Z');
    billingMonth.setUTCMonth(billingMonth.getUTCMonth() + 1);
    const exportMonth = billingMonth.toISOString().slice(0, 7);
    const selection=await db.billingOrganisationScopeCutover.findUniqueOrThrow({where:{id:1}});
    // Captured opening subscription only; the actual export reservation remains guarded.
    const subscription=await db.$transaction(async tx=>{await tx.$executeRawUnsafe('SET LOCAL session_replication_role=replica');
    const checkout = await tx.billingStripeCheckoutSession.create({ data: {
      accountId: 'adoption-live', customerId: 'adoption-live-customer', serviceId: ids.service, appKeyId: ids.appKey,
      tariffId: 'mode-period-tariff', tariffSource: 'SERVICE_DEFAULT', orgId: ids.org, teamId: null,
      scope: 'ORGANISATION', scopeKey: ids.org, billingModeTeamId: ids.team, billingModeRevision: 0,billingScopeEpoch:selection.activatedAt,
      actorJti: 'period-export', requestedByUserId: ids.user, successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64),
      status: 'complete', leaseExpiresAt: new Date() } });
    return tx.billingStripeSubscription.create({ data: { accountId: 'adoption-live', checkoutId: checkout.id,
      customerId: 'adoption-live-customer', serviceId: ids.service, tariffId: 'mode-period-tariff', tariffSource: 'SERVICE_DEFAULT',
      orgId: ids.org, teamId: null, scope: 'ORGANISATION', scopeKey: ids.org, stripeSubscriptionId: 'sub_period',
      stripeUsageItemId: 'si_period', status: 'active', livemode: true } });});
    await db.billingStripeUsageExport.create({ data: { accountId: 'adoption-live', subscriptionId: subscription.id,
      ledgerSnapshotCursor: 'period-export', billingMonth: exportMonth, billingProduct: 'funding-race', callerProduct: 'funding-race',
      currency: 'USD', cumulativeCustomerCharge: '1.00', cumulativeMeterQuantity: 100n, deltaMeterQuantity: 100n,
      stripeMeterEventIdentifier: 'period-export' } });
    await expect(check(db, 'replacement-live', exportMonth)).rejects.toThrow('BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH');
  });

  it('retries the real Serializable credit collector after a default-isolation account wins', async () => {
    // The two independent synthetic seeds use the same placeholder digest.
    await db.billingAppKey.update({ where: { id: ids.appKey }, data: { secretDigest: 'c'.repeat(64) } });
    await seedCredit(db);
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.billingTeamMode.deleteMany({ where: { teamId: creditIds.team } });
      await tx.billingStripeAccount.update({ where: { id: creditIds.account }, data: { livemode: true } });
      await tx.billingStripeCustomer.update({where:{id:creditIds.customer},data:{scope:'ORGANISATION',teamId:null,scopeKey:creditIds.org}});
      await tx.billingCreditAccount.update({where:{id:creditIds.creditAccount},data:{scope:'ORGANISATION',teamId:null,scopeKey:creditIds.org}});
    });
    const customer = await db.billingStripeCustomer.create({ data: { accountId: 'replacement-live', orgId: creditIds.org,
      teamId: null, scope: 'ORGANISATION', scopeKey: creditIds.org, stripeCustomerId: 'cus_replacement' } });
    const wallet = await db.billingCreditAccount.create({ data: { accountId: 'replacement-live', customerId: customer.id,
      orgId: creditIds.org, teamId: null,scope:'ORGANISATION',scopeKey:creditIds.org } });
    const selected = deferred(); const release = deferred();
    const first = db.$transaction(async (tx) => {
      await assertBillingPeriodMode(tx, { accountId: creditIds.account, orgId: creditIds.org,
        teamId: creditIds.team, month, sourceCreatedAt });
      selected.resolve(); await release.promise;
      await tx.billingCreditUsageSettlement.create({ data: { accountId: creditIds.account,
        creditAccountId: creditIds.creditAccount, teamId: creditIds.team, serviceId: creditIds.deepwater,
        appKeyId: creditIds.deepwaterKey, tariffId: creditIds.deepwaterTariff, billingMonth: month } });
    }, { timeout: 10_000 });
    await selected.promise;
    const usage = portfolio('same-mode-account-race', month + '-15T12:00:00.000Z', []);
    usage.scope.month = month; usage.scope.startsAt = month + '-01T00:00:00.000Z'; usage.scope.endsAt = nextMonth + '-01T00:00:00.000Z';
    let attempts = 0;
    const observed = { $transaction: (...args: Parameters<PrismaClient['$transaction']>) => {
      attempts++; return db.$transaction(...args);
    } } as unknown as PrismaClient;
    const collector = settleCreditPortfolio({ creditAccountId: wallet.id, portfolio: usage, credential: deepwaterCredential },
      { prisma: observed }).then(() => 'unexpected success', (error: Error) => error.message);
    try {
      for (let n = 0; n < 100; n++) {
        const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%assert_billing_period_mode%') AS waiting`;
        if (rows[0]?.waiting) break;
        if (n === 99) throw new Error('Serializable collector did not wait');
        await new Promise((done) => setTimeout(done, 10));
      }
    } finally { release.resolve(); }
    await first;
    expect(await collector).toContain('BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH');
    expect(attempts).toBe(2);
    expect(await db.billingCreditUsageSettlement.count({ where: { creditAccountId: wallet.id } })).toBe(0);
  });
});
