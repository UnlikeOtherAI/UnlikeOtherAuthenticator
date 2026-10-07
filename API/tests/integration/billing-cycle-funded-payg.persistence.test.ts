import { createHash, randomUUID } from 'node:crypto';

import { BillingAppKeyPurpose, BillingAssignmentScope, BillingCollectionMode,
  BillingMonthlyChargeBasis, BillingTariffMode, BillingUsagePaymentMode,
  Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { prepareBillingCycleClose } from '../../src/services/billing-cycle-close.service.js';
import { finalizePrepaidBillingCycle } from
  '../../src/services/billing-cycle-prepaid-correction.service.js';
import type { BillingInvoicePdfStorage } from
  '../../src/services/billing-invoice-storage.service.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' &&
  Boolean(process.env.DATABASE_URL);
type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

class MemoryStorage implements BillingInvoicePdfStorage {
  readonly objects = new Map<string, Buffer>();

  async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    if (this.objects.has(key)) throw new Error('TEST_DOCUMENT_ALREADY_EXISTS');
    this.objects.set(key, Buffer.from(bytes));
  }

  async read(key: string): Promise<Buffer> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error('TEST_DOCUMENT_MISSING');
    return bytes;
  }
}

describe.skipIf(!enabled)('fully funded PAYG usage with no monthly fee', () => {
  let db: TestDb;
  const storage = new MemoryStorage();
  const ids = { user: '', org: '', team: '', service: '', tariff: '', account: '',
    creditAccount: '', appKey: '' };
  const month = '2026-08';
  let meteredCost = '0';
  const receipts: Array<{ dispatchId: string; receiptId: string; cost: string }> = [];

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const email = `${randomUUID()}@example.test`;
    const user = await db.prisma.user.create({ data: { email, userKey: email } });
    ids.user = user.id;
    const org = await db.prisma.organisation.create({ data: {
      ownerId: user.id, domain: `${randomUUID()}.example.test`,
      name: 'Funded PAYG', slug: `funded-${randomUUID().slice(0, 10)}` } });
    ids.org = org.id;
    const team = await db.prisma.team.create({ data: { orgId: org.id,
      name: 'Funded team', slug: `funded-${randomUUID().slice(0, 10)}` } });
    ids.team = team.id;
    await db.prisma.teamMember.create({ data: {
      teamId: team.id, userId: user.id, teamRole: 'owner',
    } });
    const service = await db.prisma.billingService.create({ data: {
      identifier: `funded-payg-${randomUUID()}`, name: 'Funded service',
      tariffHistoryFromMonth: '2026-01' } });
    ids.service = service.id;
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId: service.id, key: 'funded-payg', version: 1, name: 'Funded PAYG',
      mode: BillingTariffMode.STANDARD, collectionMode: BillingCollectionMode.NONE,
      usagePaymentMode: BillingUsagePaymentMode.PAY_AS_YOU_GO,
      monthlyChargeBasis: BillingMonthlyChargeBasis.FLAT,
      markupBps: 3000, monthlyAmountMinor: 0n, currency: 'USD' } });
    ids.tariff = tariff.id;
    const stripeAccount = await db.prisma.billingStripeAccount.create({ data: {
      stripeAccountId: `acct_${randomUUID()}`, livemode: false } });
    ids.account = stripeAccount.id;
    const customer = await db.prisma.billingStripeCustomer.create({ data: {
      accountId: stripeAccount.id, orgId: org.id, teamId: team.id,
      scope: BillingAssignmentScope.TEAM, scopeKey: `${org.id}:${team.id}` } });
    const credit = await db.prisma.billingCreditAccount.create({ data: {
      accountId: stripeAccount.id, customerId: customer.id,
      orgId: org.id, teamId: team.id, scope: BillingAssignmentScope.TEAM,
      scopeKey: `${org.id}:${team.id}`, currency: 'USD' } });
    ids.creditAccount = credit.id;
    const appKey = await db.prisma.billingAppKey.create({ data: {
      serviceId: service.id, purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
      name: 'Funded PAYG test', keyPrefix: 'funded_payg',
      secretDigest: randomUUID(), actorIssuer: 'https://test.example',
      actorAudience: 'https://uoa.example', actorKeyId: randomUUID(),
      actorPublicJwk: { kty: 'RSA', n: 'AQAB', e: 'AQAB' },
      checkoutReturnOrigins: ['https://test.example'] } });
    ids.appKey = appKey.id;
    const adminDomain = `funded-payg-${randomUUID()}.example.test`;
    await db.prisma.domainRole.create({ data: {
      domain: adminDomain, userId: user.id, role: 'SUPERUSER',
    } });
    await db.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config(
        'app.admin_auth_domain', ${adminDomain}, true)`);
      const adjustmentId = randomUUID();
      const entryId = randomUUID();
      const key = randomUUID();
      await tx.billingCreditAdminAdjustment.create({ data: {
        id: adjustmentId, accountId: stripeAccount.id, creditAccountId: credit.id,
        orgId: org.id, teamId: team.id, signedAmountMicrocredits: 3_000_000_000n,
        reason: 'Funded PAYG test wallet', idempotencyKey: key,
        createdByUserId: user.id, createdByEmail: user.email,
        createdByAdminDomain: adminDomain, creditEntryId: entryId,
      } });
      await tx.billingCreditEntry.create({ data: {
        id: entryId, creditAccountId: credit.id, direction: 'CREDIT',
        kind: 'ADJUSTMENT', amountMicrocredits: 3_000_000_000n,
        balanceAfterMicrocredits: 3_000_000_000n, currency: 'USD',
        idempotencyKey: key, sourceType: 'credit_admin_adjustment',
        sourceId: adjustmentId, occurredAt: new Date('2026-08-01T00:00:01.000Z'),
      } });
    });
  });

  afterAll(async () => { await db?.cleanup(); });

  async function settle(cost: string, microcredits: bigint, sequence: number,
    accountBalance: bigint) {
    const dispatchId = `dispatch-${randomUUID()}`;
    const receiptId = `receipt-${randomUUID()}`;
    await db.prisma.billingPaidUsageLiability.create({ data: {
      dispatchId, receiptId, serviceId: ids.service, providerServiceId: 'provider-test',
      orgId: ids.org, teamId: ids.team, userId: ids.user, billingMonth: month,
      currency: 'USD', tariffId: ids.tariff, frozenMarkupBps: 3000,
      paymentMode: 'PAY_AS_YOU_GO', rawCostActual: cost,
      ratedQuanta: '0', ratedMicrocredits: microcredits } });
    receipts.push({ dispatchId, receiptId, cost });
    meteredCost = String(Number(meteredCost) + Number(cost));
    const ledgerId = `mup_${randomUUID().replaceAll('-', '')}`;
    const snapshot = await db.prisma.billingCreditPortfolioSnapshot.create({ data: {
      accountId: ids.account, creditAccountId: ids.creditAccount,
      orgId: ids.org, teamId: ids.team,
      perspectiveServiceId: ids.service,
      perspectiveProduct: (await db.prisma.billingService.findUniqueOrThrow({
        where: { id: ids.service } })).identifier,
      billingMonth: month, ledgerSnapshotId: ledgerId,
      ledgerSnapshotCursor: ledgerId,
      capturedAt: new Date(`2026-09-0${sequence + 1}T00:00:00.000Z`),
      sha256: 'a'.repeat(64) } });
    const settlement = sequence === 1 ? await db.prisma.billingCreditUsageSettlement.create({
      data: { accountId: ids.account, creditAccountId: ids.creditAccount,
        teamId: ids.team, tariffId: ids.tariff, serviceId: ids.service,
        appKeyId: ids.appKey, billingMonth: month, currency: 'USD' } }) :
      await db.prisma.billingCreditUsageSettlement.findFirstOrThrow({ where: {
        creditAccountId: ids.creditAccount, teamId: ids.team,
        serviceId: ids.service, billingMonth: month } });
    const adjustmentId = randomUUID();
    const debitId = randomUUID();
    const cumulativeCredits = receipts.reduce((sum, row) => sum +
      (row.cost === '1' ? 1_300_000_000n : 650_000_000n), 0n);
    await db.prisma.$transaction(async (tx) => {
      await tx.billingCreditEntry.create({ data: {
      id: debitId,
      creditAccountId: ids.creditAccount, serviceId: ids.service,
      appKeyId: ids.appKey, direction: 'DEBIT',
      kind: sequence === 1 ? 'USAGE_SETTLEMENT' : 'USAGE_SETTLEMENT_CORRECTION',
      amountMicrocredits: microcredits, balanceAfterMicrocredits: accountBalance,
      currency: 'USD', idempotencyKey: randomUUID(),
      sourceType: 'credit_usage_settlement_adjustment', sourceId: adjustmentId,
      occurredAt: new Date(`2026-08-${sequence === 1 ? '15' : '16'}T00:00:01.000Z`),
      } });
      await tx.billingCreditUsageSettlementAdjustment.create({ data: {
      id: adjustmentId, settlementId: settlement.id, accountId: ids.account,
      creditAccountId: ids.creditAccount, serviceId: ids.service,
      appKeyId: ids.appKey, portfolioSnapshotId: snapshot.id, sequence,
      deltaRatedUsageAmountMicroMinor: microcredits / 10n,
      deltaCreditsConsumedMicrocredits: microcredits,
      deltaRemainingUsageAmountMicroMinor: 0n,
      cumulativeRatedUsageAmountMicroMinor: cumulativeCredits / 10n,
      cumulativeCreditsConsumedMicrocredits: cumulativeCredits,
      cumulativeRemainingUsageAmountMicroMinor: 0n,
      creditEntryId: debitId,
      } });
      await tx.billingCreditUsageAllocation.create({ data: {
        settlementId: settlement.id, adjustmentId, serviceId: ids.service,
        appKeyId: ids.appKey, attributedUserId: ids.user,
        deltaRatedUsageAmountMicroMinor: microcredits / 10n,
        deltaCreditsConsumedMicrocredits: microcredits,
        deltaRemainingUsageAmountMicroMinor: 0n,
        cumulativeRatedUsageAmountMicroMinor: cumulativeCredits / 10n,
        cumulativeCreditsConsumedMicrocredits: cumulativeCredits,
        cumulativeRemainingUsageAmountMicroMinor: 0n,
      } });
    });
  }

  it('keeps a fully credited PAYG month cash-free through a late receipt', async () => {
    const service = await db.prisma.billingService.findUniqueOrThrow({ where: {
      id: ids.service } });
    const quote = { source: { kind: 'manual' as const, id: 'zero-fee-payg' },
      serviceId: ids.service, tariffId: ids.tariff, organisationId: ids.org,
      teamId: ids.team, scope: BillingAssignmentScope.TEAM,
      agreementId: null, billingMonth: month,
      chargeBasis: BillingMonthlyChargeBasis.FLAT,
      seatPolicy: null, seatChargeTiming: null, amountMinor: 0n, unitAmountMinor: 0n,
      uniqueHumanSeats: null, seatMilliseconds: null, monthMilliseconds: null,
      currency: 'USD', baselineCapturedAt: null, baselineMemberCount: null,
      intervals: [], capacityRevisions: [], evidenceIds: [],
      commercialEffectiveAt: null, commercialEndsAt: null, endedAt: null };
    const metering = () => ({ schemaVersion: 1 as const, product: service.identifier,
      groupBy: 'user' as const,
      scope: { organizationId: ids.org, teamId: ids.team,
        userId: null, month, startsAt: '2026-08-01T00:00:00.000Z',
        endsAt: '2026-09-01T00:00:00.000Z' }, calls: String(receipts.length),
      lines: [{ serviceId: 'provider-test', usageUnit: 'tokens',
        calls: String(receipts.length), inputUnits: '1', cachedInputUnits: '0',
        outputUnits: '1', estimatedProviderCost: null, actualProviderCost: meteredCost,
        selectedProviderCost: meteredCost, currency: 'USD', costProvenance: 'actual',
        billingProduct: service.identifier, callerProduct: service.identifier,
        originProduct: service.identifier, userId: ids.user,
        billingDisposition: 'paid' as const }],
      billingCompleteness: { state: 'complete' as const, unresolvedPaidAttempts: '0' },
      snapshot: { cursor: `cursor-${receipts.length}`, id: `snap-${receipts.length}`,
        capturedAt: '2026-09-02T00:00:00.000Z', immutable: true as const,
        sha256: 'a'.repeat(64) } });
    const proof = () => {
      const hash = createHash('sha256').update('ledger-paid-receipt-set-v1:paid\n');
      for (const row of [...receipts].sort((a, b) =>
        Buffer.compare(Buffer.from(a.dispatchId), Buffer.from(b.dispatchId)))) {
        hash.update(JSON.stringify([row.dispatchId, row.receiptId,
          Number(row.cost).toFixed(18)])).update('\n');
      }
      return { contract: 'ledger-paid-receipt-set-v1' as const,
        scope: { billing_product: service.identifier,
          organization_id: ids.org, team_id: ids.team, billing_month: month },
        snapshot: { cursor: `mpr_${'a'.repeat(32)}`,
          captured_at: '2026-09-02T00:00:00.000Z', immutable: true as const },
        paid_receipt_count: String(receipts.length), paid_receipt_sha256: hash.digest('hex'),
        zero_incremental_count: '0', zero_incremental_sha256: createHash('sha256')
          .update('ledger-paid-receipt-set-v1:zero\n').digest('hex'),
        unresolved_paid_attempts: '0', signature: 'test-signature'.repeat(10) };
    };
    const deps = { prisma: db.prisma, now: () => new Date('2026-09-03T00:00:00.000Z'),
      quote: vi.fn().mockResolvedValue(quote),
      discoverTeams: vi.fn().mockResolvedValue({ teamIds: [ids.team], snapshot: {
        cursor: 'teams', id: 'teams', capturedAt: '2026-09-02T00:00:00.000Z',
        sha256: 'b'.repeat(64) } }),
      fetchMetering: vi.fn().mockImplementation(async () => metering()),
      fetchPaidReceiptSet: vi.fn().mockImplementation(async () => proof()) };
    await settle('1', 1_300_000_000n, 1, 1_700_000_000n);
    const firstPending = await prepareBillingCycleClose({ source: quote.source,
      billingMonth: month }, deps);
    const first = await finalizePrepaidBillingCycle({ cycleId: firstPending.cycleId }, {
      prisma: db.prisma, storage });
    if (!first) throw new Error('FUNDED_PAYG_FIRST_CYCLE_NOT_FINALIZED');
    const firstRow = await db.prisma.billingCustomerCycle.findUniqueOrThrow({ where: {
      id: first.cycleId } });
    const firstTotals = (firstRow.publicSnapshot as Record<string, unknown>).totals as Array<{
      gross_total: { amount_minor: string }; credits_applied: { amount_minor: string };
      total_due: { amount_minor: string } }>;
    expect([firstTotals[0]?.gross_total.amount_minor,
      firstTotals[0]?.credits_applied.amount_minor,
      firstTotals[0]?.total_due.amount_minor]).toEqual(['130', '130', '0']);
    expect(await db.prisma.billingCustomerCycleInvoiceAllocation.count({ where: {
      cycleId: first.cycleId } })).toBe(0);
    await settle('0.5', 650_000_000n, 2, 1_050_000_000n);
    const late = await prepareBillingCycleClose({ source: quote.source,
      billingMonth: month }, deps);
    const adjusted = await finalizePrepaidBillingCycle({ cycleId: late.cycleId }, {
      prisma: db.prisma, storage });
    if (!adjusted) throw new Error('FUNDED_PAYG_LATE_CYCLE_NOT_FINALIZED');
    const latest = await db.prisma.billingCustomerCycle.findUniqueOrThrow({ where: {
      id: adjusted.cycleId } });
    const latestTotals = (latest.publicSnapshot as Record<string, unknown>).totals as Array<{
      gross_total: { amount_minor: string }; credits_applied: { amount_minor: string };
      total_due: { amount_minor: string } }>;
    expect([latestTotals[0]?.gross_total.amount_minor,
      latestTotals[0]?.credits_applied.amount_minor,
      latestTotals[0]?.total_due.amount_minor]).toEqual(['195', '195', '0']);
    expect(await db.prisma.billingInvoice.count({ where: { orgId: ids.org } })).toBe(0);
    expect(firstRow.snapshotSha256).toBe((await db.prisma.billingCustomerCycle
      .findUniqueOrThrow({ where: { id: first.cycleId } })).snapshotSha256);
  });
});
