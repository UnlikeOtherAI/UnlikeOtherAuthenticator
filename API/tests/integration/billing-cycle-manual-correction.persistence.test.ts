import { createHash, randomUUID } from 'node:crypto';

import { BillingAssignmentScope, BillingCollectionMode, BillingMonthlyChargeBasis,
  BillingTariffMode, BillingUsagePaymentMode, Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { getAdminAuthDomain } from '../../src/config/env.js';
import { prepareBillingCycleClose } from '../../src/services/billing-cycle-close.service.js';
import { captureIssuedManualBillingCycleCorrection } from
  '../../src/services/billing-cycle-manual-correction-capture.service.js';
import { prepareManualBillingCycleCorrection } from
  '../../src/services/billing-cycle-manual-correction-prepare.service.js';
import { captureIssuedManualBillingCycle } from
  '../../src/services/billing-cycle-manual-invoice.service.js';
import type { BillingInvoicePdfStorage } from
  '../../src/services/billing-invoice-storage.service.js';
import { issueBillingInvoice } from '../../src/services/billing-invoice-lifecycle.service.js';
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

describe.skipIf(!enabled)('issued manual late receipt correction', () => {
  let db: TestDb;
  const storage = new MemoryStorage();
  const ids = { user: '', org: '', team: '', service: '', tariff: '', term: '',
    contract: '', version: '', issuer: '', buyer: '', invoice: '' };
  const month = '2026-08';
  const rows: Array<{ dispatchId: string; receiptId: string; cost: string }> = [];
  let cost = '0';
  let originalCycleId = '';
  let pendingCycleId = '';

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const email = `${randomUUID()}@example.test`;
    const user = await db.prisma.user.create({ data: { email, userKey: email } });
    ids.user = user.id;
    await db.prisma.domainRole.create({ data: { userId: user.id,
      domain: getAdminAuthDomain(), role: 'SUPERUSER' } });
    const org = await db.prisma.organisation.create({ data: {
      ownerId: user.id, name: 'Manual correction', domain: `${randomUUID()}.example.test`,
      slug: `correction-${randomUUID().slice(0, 10)}`,
    } });
    ids.org = org.id;
    const team = await db.prisma.team.create({ data: { orgId: org.id,
      name: 'Usage team', slug: `usage-${randomUUID().slice(0, 10)}` } });
    ids.team = team.id;
    const service = await db.prisma.billingService.create({ data: {
      identifier: `manual-correction-${randomUUID()}`, name: 'Customer service',
      tariffHistoryFromMonth: '2026-01',
    } });
    ids.service = service.id;
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId: service.id, key: 'manual-correction', version: 1, name: 'Manual',
      mode: BillingTariffMode.CUSTOM, collectionMode: BillingCollectionMode.MANUAL,
      usagePaymentMode: BillingUsagePaymentMode.PAY_AS_YOU_GO,
      monthlyChargeBasis: BillingMonthlyChargeBasis.FLAT,
      markupBps: 3000, monthlyAmountMinor: 0n, currency: 'USD',
    } });
    ids.tariff = tariff.id;
    const contract = await db.prisma.billingOrganisationContract.create({ data: {
      orgId: org.id, reference: `correction-${randomUUID()}`, name: 'Agreement',
      status: 'ACTIVE', activatedAt: new Date('2026-08-01T00:00:00.000Z'),
    } });
    ids.contract = contract.id;
    const version = await db.prisma.billingOrganisationContractVersion.create({ data: {
      contractId: contract.id, version: 1, usageMarkupBps: 3000,
      currency: 'USD', paymentTermsDays: 30, effectiveFromMonth: month,
    } });
    ids.version = version.id;
    const term = await db.prisma.billingContractServiceTerm.create({ data: {
      contractVersionId: version.id, serviceId: service.id, tariffId: tariff.id,
      monthlyAmountMinor: 0n,
    } });
    ids.term = term.id;
    const issuer = await db.prisma.billingInvoiceIssuerProfile.create({ data: {
      key: `correction-${randomUUID().slice(0, 10)}`, legalName: 'UOA Ltd',
      billingEmail: 'billing@example.test', address: { country: 'GB' },
      invoiceNumberPrefix: `C${randomUUID().slice(0, 6).toUpperCase()}`,
    } });
    ids.issuer = issuer.id;
    const buyer = await db.prisma.billingOrganisationInvoiceProfile.create({ data: {
      orgId: org.id, legalName: 'Customer Ltd', billingEmail: email,
      billingAddress: { country: 'GB' },
    } });
    ids.buyer = buyer.id;
  });

  afterAll(async () => { await db?.cleanup(); });

  async function settle(rawCost: string, ratedMicrocredits: bigint) {
    const dispatchId = `dispatch-${randomUUID()}`;
    const receiptId = `receipt-${randomUUID()}`;
    await db.prisma.billingPaidUsageLiability.create({ data: {
      dispatchId, receiptId, serviceId: ids.service,
      providerServiceId: 'provider-test', orgId: ids.org, teamId: ids.team,
      userId: ids.user, billingMonth: month, currency: 'USD',
      tariffId: ids.tariff, frozenMarkupBps: 3000, paymentMode: 'PAY_AS_YOU_GO',
      rawCostActual: rawCost, ratedQuanta: '0', ratedMicrocredits,
    } });
    rows.push({ dispatchId, receiptId, cost: rawCost });
    cost = String(Number(cost) + Number(rawCost));
  }

  const quote = () => ({ source: { kind: 'manual' as const, id: ids.term },
    serviceId: ids.service, tariffId: ids.tariff, organisationId: ids.org,
    teamId: null, scope: BillingAssignmentScope.ORGANISATION,
    agreementId: null, billingMonth: month, chargeBasis: BillingMonthlyChargeBasis.FLAT,
    seatPolicy: null, seatChargeTiming: null, amountMinor: 0n, unitAmountMinor: 0n,
    uniqueHumanSeats: null, seatMilliseconds: null, monthMilliseconds: null,
    currency: 'USD', baselineCapturedAt: null, baselineMemberCount: null,
    intervals: [], capacityRevisions: [], evidenceIds: [],
    commercialEffectiveAt: null, commercialEndsAt: null, endedAt: null });

  function metering(product: string) {
    return { schemaVersion: 1 as const, product, groupBy: 'user' as const,
      scope: { organizationId: ids.org, teamId: ids.team, userId: null,
        month, startsAt: '2026-08-01T00:00:00.000Z',
        endsAt: '2026-09-01T00:00:00.000Z' },
      calls: String(rows.length), lines: rows.length ? [{
        serviceId: 'provider-test', usageUnit: 'tokens', calls: String(rows.length),
        inputUnits: '1', cachedInputUnits: '0', outputUnits: '1',
        estimatedProviderCost: null, actualProviderCost: cost,
        selectedProviderCost: cost, currency: 'USD', costProvenance: 'actual',
        billingProduct: product, callerProduct: product, originProduct: product,
        userId: ids.user, billingDisposition: 'paid' as const,
      }] : [], billingCompleteness: { state: 'complete' as const,
        unresolvedPaidAttempts: '0' },
      snapshot: { cursor: `cursor-${rows.length}`, id: `snap-${rows.length}`,
        capturedAt: '2026-09-02T00:00:00.000Z', immutable: true as const,
        sha256: 'a'.repeat(64) } };
  }

  function proof(product: string) {
    const ordered = [...rows].sort((a, b) =>
      Buffer.compare(Buffer.from(a.dispatchId), Buffer.from(b.dispatchId)));
    const digest = createHash('sha256').update('ledger-paid-receipt-set-v1:paid\n');
    for (const row of ordered) digest.update(JSON.stringify([
      row.dispatchId, row.receiptId, Number(row.cost).toFixed(18),
    ])).update('\n');
    return { contract: 'ledger-paid-receipt-set-v1' as const,
      scope: { billing_product: product, organization_id: ids.org,
        team_id: ids.team, billing_month: month },
      snapshot: { cursor: `mpr_${'a'.repeat(32)}`,
        captured_at: '2026-09-02T00:00:00.000Z', immutable: true as const },
      paid_receipt_count: String(rows.length), paid_receipt_sha256: digest.digest('hex'),
      zero_incremental_count: '0', zero_incremental_sha256:
        createHash('sha256').update('ledger-paid-receipt-set-v1:zero\n').digest('hex'),
      unresolved_paid_attempts: '0', signature: 'test-verified-signature'.repeat(5) };
  }

  async function close() {
    const product = (await db.prisma.billingService.findUniqueOrThrow({ where: {
      id: ids.service,
    } })).identifier;
    return prepareBillingCycleClose({ source: quote().source, billingMonth: month }, {
      prisma: db.prisma, now: () => new Date('2026-09-03T00:00:00.000Z'),
      quote: vi.fn().mockResolvedValue(quote()),
      discoverTeams: vi.fn().mockResolvedValue({ teamIds: [ids.team], snapshot: {
        cursor: `teams-${rows.length}`, id: `teams-${rows.length}`,
        capturedAt: '2026-09-02T00:00:00.000Z', sha256: 'b'.repeat(64),
      } }),
      fetchMetering: vi.fn().mockImplementation(async () => metering(product)),
      fetchPaidReceiptSet: vi.fn().mockImplementation(async () => proof(product)),
    });
  }

  it('freezes an original 20% VAT invoice and its settled usage', async () => {
    await settle('1', 1_300_000_000n);
    const original = await db.prisma.billingInvoice.create({ data: {
      orgId: ids.org, contractId: ids.contract, contractVersionId: ids.version,
      issuerProfileId: ids.issuer, buyerProfileId: ids.buyer,
      billingMonth: month, revision: 1, currency: 'USD',
      subtotalMinor: 130n, taxAmountMinor: 26n, totalMinor: 156n,
      taxTreatment: 'STANDARD_RATE', taxRateBps: 2000,
      taxLegalBasis: 'Standard VAT on taxable usage',
      issuerSnapshot: { legal_name: 'UOA Ltd', billing_email: 'billing@example.test' },
      buyerSnapshot: { legal_name: 'Customer Ltd', billing_email: 'customer@example.test' },
      calculationDigest: 'c'.repeat(64),
      lines: { create: { serviceId: ids.service,
        serviceIdentifier: (await db.prisma.billingService.findUniqueOrThrow({
          where: { id: ids.service },
        })).identifier,
        serviceName: 'Customer service', amountMinor: 130n,
        currency: 'USD', position: 1 } },
      meteringRefs: { create: { serviceId: ids.service,
        ledgerSnapshotCursor: 'initial-ledger-coverage',
        ledgerSnapshotSha256: 'd'.repeat(64),
        capturedAt: new Date('2026-09-02T00:00:00.000Z') } },
    } });
    ids.invoice = original.id;
    const line = await db.prisma.billingInvoiceLine.findFirstOrThrow({ where: {
      invoiceId: original.id,
    } });
    await db.prisma.billingInvoiceLineFinancialAllocation.create({ data: {
      lineId: line.id, invoiceId: original.id, serviceId: ids.service,
      billingMonth: month, subscriptionMinor: 0n, usageMinor: 130n,
      taxMinor: 26n, invoiceCreditMinor: 0n, totalMinor: 156n,
      dueMinor: 156n, currency: 'USD', calculationDigest: 'c'.repeat(64),
    } });
    await issueBillingInvoice({ invoiceId: original.id,
      actor: { email: 'operator@example.test' } }, { prisma: db.prisma,
      storage, now: () => new Date('2026-09-04T00:00:00.000Z'),
      authorizeAdminEffect: vi.fn().mockResolvedValue(undefined) });
    const pending = await close();
    const captured = await captureIssuedManualBillingCycle({ cycleId: pending.cycleId,
      invoiceId: original.id }, { prisma: db.prisma, storage });
    originalCycleId = captured.cycleId;
    const row = await db.prisma.billingCustomerCycle.findUniqueOrThrow({ where: {
      id: originalCycleId,
    } });
    expect(row.state).toBe('finalized');
    expect((row.publicSnapshot as Record<string, unknown>).totals).toEqual([
      expect.objectContaining({ tax: expect.objectContaining({ amount_minor: '26' }),
        total_due: expect.objectContaining({ amount_minor: '156' }) }),
    ]);
  });

  it('issues only the late usage delta and inherited tax, then replays once', async () => {
    await settle('0.5', 650_000_000n);
    const pending = await close();
    pendingCycleId = pending.cycleId;
    const actor = { userId: ids.user, tokenVersion: 0,
      email: (await db.prisma.user.findUniqueOrThrow({ where: { id: ids.user } })).email };
    const prepared = await prepareManualBillingCycleCorrection({ pendingCycleId, actor },
      { prisma: db.prisma });
    expect(await prepareManualBillingCycleCorrection({ pendingCycleId, actor },
      { prisma: db.prisma })).toEqual(prepared);
    const supplement = await db.prisma.billingInvoice.findUniqueOrThrow({ where: {
      id: prepared.invoiceId,
    }, include: { lines: true, lineFinancialAllocations: true } });
    expect([supplement.subtotalMinor, supplement.taxAmountMinor,
      supplement.totalMinor]).toEqual([65n, 13n, 78n]);
    expect(supplement.lineFinancialAllocations).toEqual([
      expect.objectContaining({ subscriptionMinor: 0n, usageMinor: 65n,
        taxMinor: 13n, dueMinor: 78n }),
    ]);
    await issueBillingInvoice({ invoiceId: supplement.id,
      actor: { email: actor.email } }, { prisma: db.prisma, storage,
      now: () => new Date('2026-09-05T00:00:00.000Z'),
      authorizeAdminEffect: vi.fn().mockResolvedValue(undefined) });
    const captured = await captureIssuedManualBillingCycleCorrection({
      invoiceId: supplement.id,
    }, { prisma: db.prisma, storage });
    expect(await captureIssuedManualBillingCycleCorrection({
      invoiceId: supplement.id,
    }, { prisma: db.prisma, storage })).toEqual(captured);
    const row = await db.prisma.billingCustomerCycle.findUniqueOrThrow({ where: {
      id: captured.cycleId,
    }, include: { documents: true } });
    expect(row.state).toBe('adjusted');
    const totals = (row.publicSnapshot as Record<string, unknown>).totals as Array<{
      tax: { amount_minor: string }; total_due: { amount_minor: string } }>;
    expect([totals[0]?.tax.amount_minor, totals[0]?.total_due.amount_minor])
      .toEqual(['39', '234']);
    expect(row.documents.filter((doc) => doc.kind === 'monthly_invoice')).toHaveLength(2);
    const original = await db.prisma.billingInvoice.findUniqueOrThrow({ where: {
      id: ids.invoice,
    } });
    expect(createHash('sha256').update(await storage.read(original.pdfObjectKey ?? ''))
      .digest('hex')).toBe(original.pdfSha256);
  });

  it('carries two settled half-cent wallet offsets across separate VAT supplements', async () => {
    const stripe = await db.prisma.billingStripeAccount.create({ data: {
      stripeAccountId: `acct_${randomUUID()}`, livemode: false } });
    const customer = await db.prisma.billingStripeCustomer.create({ data: {
      accountId: stripe.id, orgId: ids.org, teamId: null,
      scope: BillingAssignmentScope.ORGANISATION, scopeKey: ids.org } });
    const wallet = await db.prisma.billingCreditAccount.create({ data: {
      accountId: stripe.id, customerId: customer.id, orgId: ids.org,
      teamId: null, scope: BillingAssignmentScope.ORGANISATION,
      scopeKey: ids.org, currency: 'USD' } });
    const service = await db.prisma.billingService.findUniqueOrThrow({ where: {
      id: ids.service } });
    const appKey = await db.prisma.billingAppKey.create({ data: {
      serviceId: ids.service, purpose: 'CUSTOMER_LIFECYCLE', name: 'Manual funded test',
      keyPrefix: `funded_${randomUUID().slice(0, 8)}`, secretDigest: randomUUID(),
      actorIssuer: 'https://test.example', actorAudience: 'https://uoa.example',
      actorKeyId: randomUUID(), actorPublicJwk: { kty: 'RSA', n: 'AQAB', e: 'AQAB' },
      checkoutReturnOrigins: ['https://test.example'],
    } });
    const fundingId = randomUUID();
    const fundingEntryId = randomUUID();
    await db.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config(
        'app.admin_auth_domain', ${getAdminAuthDomain()}, true)`);
      await tx.billingCreditAdminAdjustment.create({ data: {
        id: fundingId, accountId: stripe.id, creditAccountId: wallet.id,
        orgId: ids.org, teamId: null, signedAmountMicrocredits: 20_000_000n,
        reason: 'Manual funded correction test', idempotencyKey: fundingId,
        createdByUserId: ids.user, createdByEmail: (await tx.user.findUniqueOrThrow({
          where: { id: ids.user } })).email,
        createdByAdminDomain: getAdminAuthDomain(), creditEntryId: fundingEntryId,
      } });
      await tx.billingCreditEntry.create({ data: {
        id: fundingEntryId, creditAccountId: wallet.id, direction: 'CREDIT',
        kind: 'ADJUSTMENT', amountMicrocredits: 20_000_000n,
        balanceAfterMicrocredits: 20_000_000n, currency: 'USD',
        idempotencyKey: fundingId, sourceType: 'credit_admin_adjustment',
        sourceId: fundingId, occurredAt: new Date('2026-08-01T00:00:01.000Z'),
      } });
    });
    const settlement = await db.prisma.billingCreditUsageSettlement.create({ data: {
      accountId: stripe.id, creditAccountId: wallet.id, teamId: ids.team,
      tariffId: ids.tariff, serviceId: ids.service, appKeyId: appKey.id,
      billingMonth: month, currency: 'USD',
    } });
    const actor = { userId: ids.user, tokenVersion: 0,
      email: (await db.prisma.user.findUniqueOrThrow({ where: { id: ids.user } })).email };
    const supplementIds: string[] = [];
    for (const sequence of [1, 2]) {
      await settle('0.5', 650_000_000n);
      const snapshotId = `mup_${randomUUID().replaceAll('-', '')}`;
      const snapshot = await db.prisma.billingCreditPortfolioSnapshot.create({ data: {
        accountId: stripe.id, creditAccountId: wallet.id, orgId: ids.org,
        teamId: ids.team, perspectiveServiceId: ids.service,
        perspectiveProduct: service.identifier, billingMonth: month,
        ledgerSnapshotId: snapshotId, ledgerSnapshotCursor: snapshotId,
        capturedAt: new Date(`2026-09-0${sequence + 5}T00:00:00.000Z`),
        sha256: 'e'.repeat(64),
      } });
      const adjustmentId = randomUUID();
      const debitId = randomUUID();
      const cumulativeCredits = BigInt(sequence) * 5_000_000n;
      const cumulativeRated = sequence === 1 ? 260_000_000n : 325_000_000n;
      await db.prisma.$transaction(async (tx) => {
        await tx.billingCreditEntry.create({ data: {
          id: debitId, creditAccountId: wallet.id, serviceId: ids.service,
          appKeyId: appKey.id, direction: 'DEBIT',
          kind: sequence === 1 ? 'USAGE_SETTLEMENT' : 'USAGE_SETTLEMENT_CORRECTION',
          amountMicrocredits: 5_000_000n,
          balanceAfterMicrocredits: 20_000_000n - cumulativeCredits,
          currency: 'USD', idempotencyKey: randomUUID(),
          sourceType: 'credit_usage_settlement_adjustment', sourceId: adjustmentId,
          occurredAt: new Date(`2026-08-${sequence + 20}T00:00:00.000Z`),
        } });
        await tx.billingCreditUsageSettlementAdjustment.create({ data: {
          id: adjustmentId, settlementId: settlement.id, accountId: stripe.id,
          creditAccountId: wallet.id, serviceId: ids.service, appKeyId: appKey.id,
          portfolioSnapshotId: snapshot.id, sequence,
          deltaRatedUsageAmountMicroMinor: sequence === 1 ? 260_000_000n : 65_000_000n,
          deltaCreditsConsumedMicrocredits: 5_000_000n,
          deltaRemainingUsageAmountMicroMinor: sequence === 1 ?
            259_500_000n : 64_500_000n,
          cumulativeRatedUsageAmountMicroMinor: cumulativeRated,
          cumulativeCreditsConsumedMicrocredits: cumulativeCredits,
          cumulativeRemainingUsageAmountMicroMinor: cumulativeRated -
            cumulativeCredits / 10n,
          creditEntryId: debitId,
        } });
        await tx.billingCreditUsageAllocation.create({ data: {
          settlementId: settlement.id, adjustmentId, serviceId: ids.service,
          appKeyId: appKey.id, attributedUserId: null,
          deltaRatedUsageAmountMicroMinor: sequence === 1 ? 260_000_000n : 65_000_000n,
          deltaCreditsConsumedMicrocredits: 5_000_000n,
          deltaRemainingUsageAmountMicroMinor: sequence === 1 ?
            259_500_000n : 64_500_000n,
          cumulativeRatedUsageAmountMicroMinor: cumulativeRated,
          cumulativeCreditsConsumedMicrocredits: cumulativeCredits,
          cumulativeRemainingUsageAmountMicroMinor: cumulativeRated -
            cumulativeCredits / 10n,
        } });
      });
      const pending = await close();
      const prepared = await prepareManualBillingCycleCorrection({
        pendingCycleId: pending.cycleId, actor,
      }, { prisma: db.prisma });
      const supplement = await db.prisma.billingInvoice.findUniqueOrThrow({ where: {
        id: prepared.invoiceId,
      }, include: { creditSettlementRefs: true, lineFinancialAllocations: true } });
      expect([supplement.subtotalMinor, supplement.taxAmountMinor,
        supplement.creditsAppliedMinor]).toEqual([65n, 13n, sequence === 1 ? 1n : 0n]);
      expect(supplement.creditSettlementRefs[0]).toMatchObject({
        creditsAppliedMicrocredits: cumulativeCredits,
        priorCreditsAppliedMicrocredits: cumulativeCredits - 5_000_000n,
      });
      await issueBillingInvoice({ invoiceId: supplement.id,
        actor: { email: actor.email } }, { prisma: db.prisma, storage,
        now: () => new Date(`2026-09-0${sequence + 5}T00:00:00.000Z`),
        authorizeAdminEffect: vi.fn().mockResolvedValue(undefined) });
      supplementIds.push(supplement.id);
      const captured = await captureIssuedManualBillingCycleCorrection({
        invoiceId: supplement.id,
      }, { prisma: db.prisma, storage });
      const cycle = await db.prisma.billingCustomerCycle.findUniqueOrThrow({ where: {
        id: captured.cycleId,
      } });
      const totals = (cycle.publicSnapshot as Record<string, unknown>).totals as Array<{
        credits_applied: { amount_minor: string }; total_due: { amount_minor: string } }>;
      expect(totals[0]?.credits_applied.amount_minor).toBe('1');
      expect(totals[0]?.total_due.amount_minor)
        .toBe(sequence === 1 ? '311' : '389');
    }
    for (const invoiceId of supplementIds) {
      const [result] = await db.prisma.$queryRaw<Array<{ valid: boolean }>>(
        Prisma.sql`SELECT uoa_invoice_credit_carry_valid(${invoiceId}) AS valid`);
      expect(result?.valid).toBe(true);
    }
    const latest = await db.prisma.billingInvoiceCreditSettlementReference.findFirstOrThrow({
      where: { invoiceId: supplementIds[1] },
    });
    await expect(db.prisma.billingInvoiceCreditSettlementReference.update({
      where: { id: latest.id }, data: { priorCreditsAppliedMicrocredits: 0n },
    })).rejects.toThrow();
  });
});
