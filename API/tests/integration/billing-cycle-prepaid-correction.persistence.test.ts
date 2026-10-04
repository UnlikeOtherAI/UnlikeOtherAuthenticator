import { createHash, randomUUID } from 'node:crypto';

import {
  BillingAssignmentScope, BillingCollectionMode, BillingMonthlyChargeBasis, Prisma,
  BillingTariffMode, BillingUsagePaymentMode,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { prepareBillingCycleClose } from '../../src/services/billing-cycle-close.service.js';
import { runBillingCycleCloseBatch } from '../../src/services/billing-cycle-close-run.service.js';
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

describe.skipIf(!enabled)('prepaid finalized cycle late receipt', () => {
  let db: TestDb;
  const storage = new MemoryStorage();
  const ids = { user: '', org: '', team: '', service: '', tariff: '',
    account: '', credit: '', runtimeKey: '' };
  const receipts: Array<{ dispatchId: string; receiptId: string;
    cost: string; microcredits: bigint }> = [];
  const month = '2026-08';
  let meteredCost = '0';

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const user = await db.prisma.user.create({ data: {
      email: `${randomUUID()}@example.com`, userKey: `${randomUUID()}@example.com`,
      name: 'Cycle customer',
    } });
    ids.user = user.id;
    const org = await db.prisma.organisation.create({ data: {
      domain: `${randomUUID()}.example.com`, name: 'Prepaid cycle',
      slug: `prepaid-${randomUUID().slice(0, 10)}`, ownerId: user.id,
    } });
    ids.org = org.id;
    const team = await db.prisma.team.create({ data: {
      orgId: org.id, name: 'Prepaid team',
      slug: `prepaid-${randomUUID().slice(0, 10)}`,
    } });
    ids.team = team.id;
    const service = await db.prisma.billingService.create({ data: {
      identifier: `prepaid-cycle-${randomUUID()}`, name: 'Prepaid service',
      tariffHistoryFromMonth: '2026-01',
    } });
    ids.service = service.id;
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId: service.id, key: 'prepaid', version: 1, name: 'Prepaid',
      mode: BillingTariffMode.STANDARD, collectionMode: BillingCollectionMode.NONE,
      usagePaymentMode: BillingUsagePaymentMode.PREPAID,
      monthlyChargeBasis: BillingMonthlyChargeBasis.FLAT,
      markupBps: 3000, monthlyAmountMinor: 0n, currency: 'USD',
    } });
    ids.tariff = tariff.id;
    const account = await db.prisma.billingStripeAccount.create({ data: {
      stripeAccountId: `acct_${randomUUID()}`, livemode: false,
    } });
    ids.account = account.id;
    const customer = await db.prisma.billingStripeCustomer.create({ data: {
      accountId: account.id, orgId: org.id, teamId: team.id,
      scope: BillingAssignmentScope.TEAM, scopeKey: `${org.id}:${team.id}`,
    } });
    const credit = await db.prisma.billingCreditAccount.create({ data: {
      accountId: account.id, customerId: customer.id,
      orgId: org.id, teamId: team.id, scope: BillingAssignmentScope.TEAM,
      scopeKey: `${org.id}:${team.id}`, currency: 'USD',
    } });
    ids.credit = credit.id;
    const key = await db.prisma.billingLedgerRuntimeKey.create({ data: {
      serviceId: service.id, secretDigest: createHash('sha256')
        .update(randomUUID()).digest('hex'),
      keyPrefix: 'cycle-proof', ledgerAudience: 'https://ledger.example',
      sourceDomain: 'example.com', createdByEmail: 'operator@example.com',
    } });
    ids.runtimeKey = key.id;
    const adminDomain = `billing-cycle-${randomUUID()}.example.test`;
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
        id: adjustmentId, accountId: account.id, creditAccountId: credit.id,
        orgId: org.id, teamId: team.id, signedAmountMicrocredits: 3_000_000_000n,
        reason: 'Funded prepaid test account', idempotencyKey: key,
        createdByUserId: user.id, createdByEmail: user.email,
        createdByAdminDomain: adminDomain, creditEntryId: entryId,
      } });
      await tx.billingCreditEntry.create({ data: {
        id: entryId, creditAccountId: credit.id,
        direction: 'CREDIT', kind: 'ADJUSTMENT',
        amountMicrocredits: 3_000_000_000n,
        balanceAfterMicrocredits: 3_000_000_000n,
        currency: 'USD', idempotencyKey: key,
        sourceType: 'credit_admin_adjustment', sourceId: adjustmentId,
        occurredAt: new Date('2026-08-01T00:00:01.000Z'),
      } });
    });
  });

  afterAll(async () => { await db?.cleanup(); });

  async function settle(cost: string, microcredits: bigint, balanceAfter: bigint) {
    const dispatchId = `dispatch-${randomUUID()}`;
    const receiptId = `receipt-${randomUUID()}`;
    const reservation = await db.prisma.billingPrepaidReservation.create({ data: {
      dispatchId, requestFingerprint: 'a'.repeat(64), receiptId,
      creditAccountId: ids.credit, tariffId: ids.tariff,
      serviceId: ids.service, providerServiceId: 'provider-test',
      appKeyId: ids.runtimeKey, orgId: ids.org, teamId: ids.team,
      userId: ids.user, billingMonth: month,
      dispatchStartedAt: new Date('2026-08-15T12:00:00.000Z'),
      currency: 'USD', rawCostBound: cost,
      reservedMicrocredits: microcredits, rawCostActual: cost,
      debitedMicrocredits: microcredits, status: 'SETTLED',
      terminalAt: new Date('2026-08-15T12:00:02.000Z'),
    } });
    await db.prisma.billingCreditEntry.create({ data: {
      creditAccountId: ids.credit, serviceId: ids.service,
      ledgerRuntimeKeyId: ids.runtimeKey,
      prepaidReservationId: reservation.id, attributedUserId: ids.user,
      direction: 'DEBIT', kind: 'PREPAID_USAGE',
      amountMicrocredits: microcredits, balanceAfterMicrocredits: balanceAfter,
      currency: 'USD', idempotencyKey: randomUUID(),
      sourceType: 'prepaid_provider_receipt', sourceId: reservation.id,
      occurredAt: new Date('2026-08-15T12:00:02.000Z'),
    } });
    await db.prisma.billingPaidUsageLiability.create({ data: {
      dispatchId, receiptId, serviceId: ids.service,
      providerServiceId: 'provider-test', orgId: ids.org, teamId: ids.team,
      userId: ids.user, billingMonth: month, currency: 'USD',
      tariffId: ids.tariff, frozenMarkupBps: 3000, paymentMode: 'PREPAID',
      creditAccountId: ids.credit, rawCostActual: cost,
      ratedQuanta: '0', ratedMicrocredits: microcredits,
    } });
    receipts.push({ dispatchId, receiptId, cost, microcredits });
  }

  const quote = () => ({
    source: { kind: 'manual' as const, id: 'prepaid-zero-fee-source' },
    serviceId: ids.service, tariffId: ids.tariff, organisationId: ids.org,
    teamId: ids.team, scope: BillingAssignmentScope.TEAM,
    agreementId: null, billingMonth: month,
    chargeBasis: BillingMonthlyChargeBasis.FLAT,
    seatPolicy: null, seatChargeTiming: null,
    amountMinor: 0n, unitAmountMinor: 0n, uniqueHumanSeats: null,
    seatMilliseconds: null, monthMilliseconds: null,
    currency: 'USD', baselineCapturedAt: null, baselineMemberCount: null,
    intervals: [], capacityRevisions: [], evidenceIds: [],
    commercialEffectiveAt: null, commercialEndsAt: null, endedAt: null,
  });

  const fetchMetering = () => ({
    schemaVersion: 1 as const, product: '',
    groupBy: 'user' as const,
    scope: { organizationId: ids.org, teamId: ids.team,
      userId: null, month, startsAt: '2026-08-01T00:00:00.000Z',
      endsAt: '2026-09-01T00:00:00.000Z' },
    calls: String(receipts.length),
    lines: receipts.length ? [{
      serviceId: 'provider-test', usageUnit: 'tokens',
      calls: String(receipts.length), inputUnits: '1',
      cachedInputUnits: '0', outputUnits: '1',
      estimatedProviderCost: null, actualProviderCost: meteredCost,
      selectedProviderCost: meteredCost, currency: 'USD',
      costProvenance: 'actual',
      billingProduct: '', callerProduct: '', originProduct: '',
      userId: ids.user, billingDisposition: 'paid' as const,
    }] : [],
    billingCompleteness: { state: 'complete' as const,
      unresolvedPaidAttempts: '0' },
    snapshot: { cursor: `cursor-${receipts.length}`,
      id: `snapshot-${receipts.length}`,
      capturedAt: '2026-09-02T00:00:00.000Z',
      immutable: true as const, sha256: 'b'.repeat(64) },
  });

  async function proof(product: string) {
    const rows = [...receipts].sort((a, b) =>
      Buffer.compare(Buffer.from(a.dispatchId), Buffer.from(b.dispatchId)));
    const hash = createHash('sha256').update('ledger-paid-receipt-set-v1:paid\n');
    for (const row of rows) hash.update(JSON.stringify([
      row.dispatchId, row.receiptId, Number(row.cost).toFixed(18),
    ])).update('\n');
    return { contract: 'ledger-paid-receipt-set-v1' as const,
      scope: { billing_product: product, organization_id: ids.org,
        team_id: ids.team, billing_month: month },
      snapshot: { cursor: `mpr_${'a'.repeat(32)}`,
        captured_at: '2026-09-02T00:00:00.000Z', immutable: true as const },
      paid_receipt_count: String(rows.length),
      paid_receipt_sha256: hash.digest('hex'),
      zero_incremental_count: '0', zero_incremental_sha256:
        createHash('sha256').update('ledger-paid-receipt-set-v1:zero\n').digest('hex'),
      unresolved_paid_attempts: '0',
      signature: 'test-verified-signature'.repeat(5),
    };
  }

  it('finalizes zero-fee prepaid and a later settled debit without reissuing cash', async () => {
    const service = await db.prisma.billingService.findUniqueOrThrow({
      where: { id: ids.service },
    });
    const metering = vi.fn().mockImplementation(async () => {
      const usage = fetchMetering();
      return { ...usage, product: service.identifier,
        lines: usage.lines.map((line) => ({ ...line,
          billingProduct: service.identifier,
          callerProduct: service.identifier, originProduct: service.identifier })) };
    });
    const deps = { prisma: db.prisma,
      now: () => new Date('2026-09-03T00:00:00.000Z'),
      quote: vi.fn().mockImplementation(async () => quote()),
      fetchMetering: metering,
      fetchPaidReceiptSet: vi.fn().mockImplementation(async () => proof(service.identifier)) };
    await settle('1', 1_300_000_000n, 1_700_000_000n);
    meteredCost = '1';
    const firstPending = await prepareBillingCycleClose({
      source: quote().source, billingMonth: month,
    }, deps);
    const watch = await db.prisma.billingCycleCloseWatch.create({ data: {
      sourceKind: 'team_usage', sourceId: `${ids.service}:${ids.org}:${ids.team}`,
      serviceId: ids.service, orgId: ids.org, teamId: ids.team,
      billingMonth: month, nextCheckAt: new Date('2020-01-01T00:00:00.000Z'),
    } });
    const finalize = vi.fn((params: { cycleId: string }) =>
      finalizePrepaidBillingCycle(params, { prisma: db.prisma, storage }));
    expect(await runBillingCycleCloseBatch({ prisma: db.prisma,
      now: new Date('2026-09-03T00:00:00.000Z'),
      team: vi.fn().mockResolvedValue(firstPending), finalizePrepaid: finalize,
    })).toMatchObject({ checked: 1, held: 0 });
    expect(finalize).toHaveBeenCalledOnce();
    const first = await finalize.mock.results[0]?.value;
    expect(first).not.toBeNull();
    expect((await db.prisma.billingCycleCloseWatch.findUniqueOrThrow({
      where: { id: watch.id },
    })).lastCycleId).toBe(first!.cycleId);
    const original = await db.prisma.billingCustomerCycle.findUniqueOrThrow({
      where: { id: first!.cycleId },
    });
    expect(original.state).toBe('finalized');
    expect((original.publicSnapshot as { credits: { consumed: string } })
      .credits.consumed).toBe('1300');
    expect(await finalizePrepaidBillingCycle({ cycleId: firstPending.cycleId },
      { prisma: db.prisma, storage })).toEqual(first);
    expect((await prepareBillingCycleClose({ source: quote().source,
      billingMonth: month }, deps)).cycleId).toBe(first!.cycleId);

    await settle('0.5', 650_000_000n, 1_050_000_000n);
    meteredCost = '1.5';
    const late = await prepareBillingCycleClose({ source: quote().source,
      billingMonth: month }, deps);
    const pending = await db.prisma.billingCustomerCycle.findUniqueOrThrow({
      where: { id: late.cycleId },
    });
    expect(pending.state).toBe('pending_reconciliation');
    expect((pending.publicSnapshot as { correction_of_cycle_id: string })
      .correction_of_cycle_id).toBe(first!.cycleId);
    const corrected = await finalizePrepaidBillingCycle({ cycleId: late.cycleId },
      { prisma: db.prisma, storage });
    expect(corrected).not.toBeNull();
    const latest = await db.prisma.billingCustomerCycle.findUniqueOrThrow({
      where: { id: corrected!.cycleId },
    });
    expect(latest.state).toBe('adjusted');
    expect((latest.publicSnapshot as { credits: { consumed: string };
      totals: Array<{ total_due: { amount_minor: string } }> })
      .credits.consumed).toBe('1950');
    expect((latest.publicSnapshot as { totals: Array<{
      total_due: { amount_minor: string } }> }).totals[0]?.total_due.amount_minor).toBe('0');
    expect(original.snapshotSha256).toBe((await db.prisma.billingCustomerCycle
      .findUniqueOrThrow({ where: { id: first!.cycleId } })).snapshotSha256);
    expect(await db.prisma.billingCustomerCycleInvoiceAllocation.count({ where: {
      cycleId: corrected!.cycleId,
    } })).toBe(0);
    expect(await finalizePrepaidBillingCycle({ cycleId: late.cycleId },
      { prisma: db.prisma, storage })).toEqual(corrected);
    await settle('0.25', 325_000_000n, 725_000_000n);
    meteredCost = '1.75';
    const secondLate = await prepareBillingCycleClose({
      source: quote().source, billingMonth: month,
    }, deps);
    const secondPending = await db.prisma.billingCustomerCycle.findUniqueOrThrow({
      where: { id: secondLate.cycleId },
    });
    expect((secondPending.publicSnapshot as { correction_of_cycle_id: string })
      .correction_of_cycle_id).toBe(corrected!.cycleId);
    const secondCorrection = await finalizePrepaidBillingCycle({
      cycleId: secondLate.cycleId,
    }, { prisma: db.prisma, storage });
    expect(secondCorrection).not.toBeNull();
    const secondView = await db.prisma.billingCustomerCycle.findUniqueOrThrow({
      where: { id: secondCorrection!.cycleId },
    });
    expect((secondView.publicSnapshot as { credits: { consumed: string } })
      .credits.consumed).toBe('2275');
    expect(await db.prisma.billingCreditEntry.count({ where: {
      creditAccountId: ids.credit, kind: 'PREPAID_USAGE',
    } })).toBe(3);
  });
});
