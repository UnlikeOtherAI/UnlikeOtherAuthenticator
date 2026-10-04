import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { BillingAssignmentScope, BillingCollectionMode, BillingMonthlyChargeBasis,
  BillingTariffMode, BillingUsagePaymentMode } from '@prisma/client';
import { billingCustomerInvoiceDetailV1JsonSchema } from
  '@unlikeotherai/billing-statement-protocol';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { getAdminAuthDomain } from '../../src/config/env.js';
import { prepareBillingCycleClose } from '../../src/services/billing-cycle-close.service.js';
import { captureIssuedManualBillingCycle } from
  '../../src/services/billing-cycle-manual-invoice.service.js';
import { captureIssuedManualCreditNote } from
  '../../src/services/billing-cycle-manual-credit-note-capture.service.js';
import { prepareManualInvoiceCreditNote } from
  '../../src/services/billing-manual-credit-note-prepare.service.js';
import { projectManualCustomerInvoiceSummary } from
  '../../src/services/billing-customer-invoice-manual.service.js';
import { projectCustomerCreditNoteSummary } from
  '../../src/services/billing-customer-invoice-credit-note.service.js';
import { getCustomerInvoiceDetail } from
  '../../src/services/billing-customer-invoice-read.service.js';
import type { BillingCycleContext } from
  '../../src/services/billing-cycle-read.service.js';
import { issueManualCreditNote } from
  '../../src/services/billing-manual-credit-note-issuer.service.js';
import { issueBillingInvoice, recordBillingInvoicePayment } from
  '../../src/services/billing-invoice-lifecycle.service.js';
import type { BillingInvoicePdfStorage } from
  '../../src/services/billing-invoice-storage.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { AppError } from '../../src/utils/errors.js';

vi.mock('../../src/services/billing-actor.service.js', () => ({
  verifyBillingActor: vi.fn().mockResolvedValue({}),
}));

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
    if (!bytes) throw new AppError('NOT_FOUND', 404, 'BILLING_INVOICE_PDF_NOT_FOUND');
    return bytes;
  }
}

describe.skipIf(!enabled)('manual legal credit note', () => {
  let db: TestDb;
  const storage = new MemoryStorage();
  const ids = { user: '', org: '', team: '', service: '', tariff: '', term: '',
    contract: '', version: '', issuer: '', buyer: '', invoice: '', originalCycle: '' };
  const month = '2026-08';
  const actor = { userId: '', tokenVersion: 0, email: '' };
  const issuerParty = { legal_name: 'UOA Limited', billing_email: 'billing@example.test',
    address: { line1: '1 Main Street', city: 'London', postal_code: 'SW1A 1AA',
      country: 'GB' } };
  const buyerParty = { legal_name: 'Customer Limited', billing_email: 'buyer@example.test',
    billing_address: { line1: '2 Market Street', city: 'London', postal_code: 'EC1A 1AA',
      country: 'GB' } };

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    actor.email = `${randomUUID()}@example.test`;
    const user = await db.prisma.user.create({ data: { email: actor.email,
      userKey: actor.email } });
    ids.user = actor.userId = user.id;
    await db.prisma.domainRole.create({ data: { userId: user.id,
      domain: getAdminAuthDomain(), role: 'SUPERUSER' } });
    const org = await db.prisma.organisation.create({ data: {
      ownerId: user.id, name: 'Credit note customer',
      domain: `${randomUUID()}.example.test`,
      slug: `note-${randomUUID().slice(0, 10)}` } });
    ids.org = org.id;
    const team = await db.prisma.team.create({ data: { orgId: org.id,
      name: 'Selected team', slug: `note-${randomUUID().slice(0, 10)}` } });
    ids.team = team.id;
    await db.prisma.orgMember.create({ data: { orgId: org.id, userId: user.id,
      role: 'owner' } });
    await db.prisma.teamMember.create({ data: { teamId: team.id, userId: user.id,
      teamRole: 'owner' } });
    const service = await db.prisma.billingService.create({ data: {
      identifier: process.env.BILLING_CREDIT_NOTE_FIXTURE_PRODUCT ?? 'nessie',
      name: 'Customer service',
      tariffHistoryFromMonth: '2026-01' } });
    ids.service = service.id;
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId: service.id, key: 'manual-note', version: 1, name: 'Manual',
      mode: BillingTariffMode.CUSTOM, collectionMode: BillingCollectionMode.MANUAL,
      usagePaymentMode: BillingUsagePaymentMode.PAY_AS_YOU_GO,
      monthlyChargeBasis: BillingMonthlyChargeBasis.FLAT,
      markupBps: 3000, monthlyAmountMinor: 130n, currency: 'USD' } });
    ids.tariff = tariff.id;
    const contract = await db.prisma.billingOrganisationContract.create({ data: {
      orgId: org.id, reference: `note-${randomUUID()}`, name: 'Agreement',
      status: 'ACTIVE', activatedAt: new Date('2026-08-01T00:00:00.000Z') } });
    ids.contract = contract.id;
    const version = await db.prisma.billingOrganisationContractVersion.create({ data: {
      contractId: contract.id, version: 1, usageMarkupBps: 3000,
      currency: 'USD', paymentTermsDays: 30, effectiveFromMonth: month } });
    ids.version = version.id;
    const term = await db.prisma.billingContractServiceTerm.create({ data: {
      contractVersionId: version.id, serviceId: service.id, tariffId: tariff.id,
      monthlyAmountMinor: 130n } });
    ids.term = term.id;
    const issuer = await db.prisma.billingInvoiceIssuerProfile.create({ data: {
      key: `note-${randomUUID().slice(0, 10)}`, legalName: 'UOA Limited',
      billingEmail: 'billing@example.test', address: issuerParty.address,
      invoiceNumberPrefix: `N${randomUUID().slice(0, 6).toUpperCase()}` } });
    ids.issuer = issuer.id;
    const buyer = await db.prisma.billingOrganisationInvoiceProfile.create({ data: {
      orgId: org.id, legalName: 'Customer Limited', billingEmail: actor.email,
      billingAddress: buyerParty.billing_address } });
    ids.buyer = buyer.id;
    const invoice = await db.prisma.billingInvoice.create({ data: {
      orgId: org.id, contractId: contract.id, contractVersionId: version.id,
      issuerProfileId: issuer.id, buyerProfileId: buyer.id, billingMonth: month,
      revision: 1, currency: 'USD', subtotalMinor: 130n, taxAmountMinor: 26n,
      totalMinor: 156n, taxTreatment: 'STANDARD_RATE', taxRateBps: 2000,
      taxLegalBasis: 'Standard VAT on subscription',
      issuerSnapshot: issuerParty, buyerSnapshot: buyerParty,
      calculationDigest: 'c'.repeat(64), lines: { create: {
        serviceId: service.id, serviceIdentifier: service.identifier,
        serviceName: 'Customer service', amountMinor: 130n,
        currency: 'USD', position: 1 } },
      meteringRefs: { create: { serviceId: service.id,
        ledgerSnapshotCursor: 'complete-no-paid-usage',
        ledgerSnapshotSha256: 'd'.repeat(64),
        capturedAt: new Date('2026-09-02T00:00:00.000Z') } },
    } });
    ids.invoice = invoice.id;
    const line = await db.prisma.billingInvoiceLine.findFirstOrThrow({ where: {
      invoiceId: invoice.id } });
    await db.prisma.billingInvoiceLineFinancialAllocation.create({ data: {
      lineId: line.id, invoiceId: invoice.id, serviceId: service.id,
      billingMonth: month, subscriptionMinor: 130n, usageMinor: 0n,
      taxMinor: 26n, invoiceCreditMinor: 0n, totalMinor: 156n,
      dueMinor: 156n, currency: 'USD', calculationDigest: 'c'.repeat(64) } });
    await issueBillingInvoice({ invoiceId: invoice.id, actor }, { prisma: db.prisma,
      storage, now: () => new Date('2026-09-04T00:00:00.000Z'),
      authorizeAdminEffect: vi.fn().mockResolvedValue(undefined) });
  });

  afterAll(async () => { await db?.cleanup(); });

  it('issues one immutable taxed cancellation and projects verified cash only', async () => {
    const product = (await db.prisma.billingService.findUniqueOrThrow({ where: {
      id: ids.service } })).identifier;
    const quote = { source: { kind: 'manual' as const, id: ids.term },
      serviceId: ids.service, tariffId: ids.tariff, organisationId: ids.org,
      teamId: null, scope: BillingAssignmentScope.ORGANISATION,
      agreementId: null, billingMonth: month,
      chargeBasis: BillingMonthlyChargeBasis.FLAT, seatPolicy: null,
      seatChargeTiming: null, amountMinor: 130n, unitAmountMinor: 130n,
      uniqueHumanSeats: null, seatMilliseconds: null, monthMilliseconds: null,
      currency: 'USD', baselineCapturedAt: null, baselineMemberCount: null,
      intervals: [], capacityRevisions: [], evidenceIds: [],
      commercialEffectiveAt: null, commercialEndsAt: null, endedAt: null };
    const pending = await prepareBillingCycleClose({ source: quote.source,
      billingMonth: month }, { prisma: db.prisma,
      now: () => new Date('2026-09-03T00:00:00.000Z'),
      quote: vi.fn().mockResolvedValue(quote),
      discoverTeams: vi.fn().mockResolvedValue({ teamIds: [], snapshot: {
        cursor: 'no-teams', id: 'no-teams',
        capturedAt: '2026-09-02T00:00:00.000Z', sha256: 'b'.repeat(64) } }),
      fetchMetering: vi.fn().mockResolvedValue({ schemaVersion: 1, product,
        groupBy: 'user', scope: { organizationId: ids.org, teamId: null,
          userId: null, month, startsAt: '2026-08-01T00:00:00.000Z',
          endsAt: '2026-09-01T00:00:00.000Z' }, calls: '0', lines: [],
        billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
        snapshot: { cursor: 'no-usage', id: 'no-usage',
          capturedAt: '2026-09-02T00:00:00.000Z', immutable: true,
          sha256: 'a'.repeat(64) } }),
      fetchPaidReceiptSet: vi.fn().mockResolvedValue({
        contract: 'ledger-paid-receipt-set-v1',
        scope: { billing_product: product, organization_id: ids.org,
          team_id: null, billing_month: month },
        snapshot: { cursor: `mpr_${'a'.repeat(32)}`,
          captured_at: '2026-09-02T00:00:00.000Z', immutable: true },
        paid_receipt_count: '0', paid_receipt_sha256:
          createHash('sha256').update('ledger-paid-receipt-set-v1:paid\n').digest('hex'),
        zero_incremental_count: '0', zero_incremental_sha256:
          createHash('sha256').update('ledger-paid-receipt-set-v1:zero\n').digest('hex'),
        unresolved_paid_attempts: '0', signature: 'test-signature'.repeat(10) }),
    });
    const captured = await captureIssuedManualBillingCycle({ cycleId: pending.cycleId,
      invoiceId: ids.invoice }, { prisma: db.prisma, storage });
    ids.originalCycle = captured.cycleId;
    const originalInvoice = await db.prisma.billingInvoice.findUniqueOrThrow({ where: {
      id: ids.invoice } });
    const originalPdf = await storage.read(originalInvoice.pdfObjectKey ?? '');
    await recordBillingInvoicePayment({ invoiceId: ids.invoice, kind: 'payment',
      amountMinor: '100', currency: 'USD', idempotencyKey: `paid-${randomUUID()}`,
      occurredAt: new Date('2026-09-05T00:00:00.000Z'), actor }, {
      prisma: db.prisma, now: () => new Date('2026-09-05T00:00:01.000Z'),
      authorizeAdminEffect: vi.fn().mockResolvedValue(undefined) });
    const prepared = await prepareManualInvoiceCreditNote({ invoiceId: ids.invoice,
      reason: 'Verified cancellation', actor }, { prisma: db.prisma });
    expect(await prepareManualInvoiceCreditNote({ invoiceId: ids.invoice,
      reason: 'Verified cancellation', actor }, { prisma: db.prisma })).toEqual(prepared);
    const issued = await issueManualCreditNote({ creditNoteId: prepared.id, actor }, {
      prisma: db.prisma, storage, now: () => new Date('2026-09-06T00:00:00.000Z') });
    expect(issued.number).toMatch(/^CN-/);
    const result = await captureIssuedManualCreditNote({ creditNoteId: prepared.id }, {
      prisma: db.prisma, storage });
    expect(await captureIssuedManualCreditNote({ creditNoteId: prepared.id }, {
      prisma: db.prisma, storage })).toEqual(result);
    const row = await db.prisma.billingCustomerCycle.findUniqueOrThrow({ where: {
      id: result.cycleId }, include: { documents: true } });
    expect(row.state).toBe('voided');
    const totals = (row.publicSnapshot as Record<string, unknown>).totals as Array<{
      total_due: { amount_minor: string }; total_paid: { amount_minor: string };
      customer_credit_due: { amount_minor: string } }>;
    expect([totals[0]?.total_due.amount_minor, totals[0]?.total_paid.amount_minor,
      totals[0]?.customer_credit_due.amount_minor]).toEqual(['0', '100', '100']);
    expect(row.documents.filter((doc) => doc.kind === 'credit_note')).toHaveLength(1);
    const legalSource = await db.prisma.billingManualCreditNote.findUniqueOrThrow({
      where: { id: prepared.id }, include: { originalInvoice: { include: {
        lines: true, paymentEvents: true } } },
    });
    const legalView = projectCustomerCreditNoteSummary(legalSource, '2026-09');
    expect([legalView.kind, legalView.totals.gross_total.amount_minor,
      legalView.totals.voided_amount.amount_minor,
      legalView.totals.total_due.amount_minor]).toEqual([
      'credit_note', '156', '156', '0',
    ]);
    expect(legalView.totals.customer_credit_due?.amount_minor).toBe('100');
    const originalView = projectManualCustomerInvoiceSummary(
      await db.prisma.billingInvoice.findUniqueOrThrow({ where: { id: ids.invoice },
        include: { lines: true, paymentEvents: true, manualCreditNotes: true } }),
      '2026-09');
    expect(originalView.status).toBe('voided');
    expect([originalView.totals.voided_amount.amount_minor,
      originalView.totals.total_due.amount_minor,
      originalView.totals.total_paid.amount_minor,
      originalView.totals.outstanding.amount_minor]).toEqual(['156', '0', '100', '0']);
    expect(await storage.read(originalInvoice.pdfObjectKey ?? '')).toEqual(originalPdf);
    await expect(db.prisma.billingManualCreditNote.update({ where: { id: prepared.id },
      data: { totalCreditMinor: 1n } })).rejects.toThrow();
    await recordBillingInvoicePayment({ invoiceId: ids.invoice, kind: 'refund',
      amountMinor: '40', currency: 'USD', idempotencyKey: `refund-${randomUUID()}`,
      occurredAt: new Date('2026-09-07T00:00:00.000Z'), actor }, {
      prisma: db.prisma, now: () => new Date('2026-09-07T00:00:01.000Z'),
      authorizeAdminEffect: vi.fn().mockResolvedValue(undefined) });
    const refunded = await captureIssuedManualCreditNote({ creditNoteId: prepared.id }, {
      prisma: db.prisma, storage });
    expect(refunded.cycleId).not.toBe(result.cycleId);
    const later = await db.prisma.billingCustomerCycle.findUniqueOrThrow({ where: {
      id: refunded.cycleId }, include: { documents: true } });
    const laterTotals = (later.publicSnapshot as Record<string, unknown>).totals as Array<{
      customer_credit_due: { amount_minor: string } }>;
    expect(laterTotals[0]?.customer_credit_due.amount_minor).toBe('60');
    const context: BillingCycleContext = { credential: { service: {
      id: ids.service, identifier: product, name: 'Customer service',
    } } as BillingCycleContext['credential'],
    actorToken: 'fixture-signed-actor', endpoint: '/billing/v1/invoices/detail',
    request: { product, organisationId: ids.org, teamId: ids.team,
      userId: ids.user } };
    const detail = await getCustomerInvoiceDetail(context, `credit_note:${prepared.id}`,
      { prisma: db.prisma });
    expect(detail.totals.customer_credit_due?.amount_minor).toBe('60');
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(billingCustomerInvoiceDetailV1JsonSchema);
    expect(validate(detail), JSON.stringify(validate.errors)).toBe(true);
    if (process.env.BILLING_CREDIT_NOTE_CONFORMANCE_OUTPUT) {
      writeFileSync(process.env.BILLING_CREDIT_NOTE_CONFORMANCE_OUTPUT,
        `${JSON.stringify(detail, null, 2)}\n`);
    }
    expect(later.documents.filter((doc) => doc.kind === 'credit_note')).toHaveLength(1);
    expect(await storage.read(originalInvoice.pdfObjectKey ?? '')).toEqual(originalPdf);
    expect(await captureIssuedManualCreditNote({ creditNoteId: prepared.id }, {
      prisma: db.prisma, storage })).toEqual(refunded);
  });
});
