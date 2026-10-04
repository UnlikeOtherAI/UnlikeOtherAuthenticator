import { randomUUID } from 'node:crypto';

import {
  BillingAssignmentScope, BillingCollectionMode, BillingInvoiceStatus,
  BillingMonthlyChargeBasis, BillingOrganisationContractStatus, BillingTariffMode,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { prepareBillingCycleClose } from '../../src/services/billing-cycle-close.service.js';
import { captureIssuedManualBillingCycle } from '../../src/services/billing-cycle-manual-invoice.service.js';
import { refreshIssuedManualBillingCyclePayment } from '../../src/services/billing-cycle-manual-payment.service.js';
import { refreshVoidedManualBillingCycle } from '../../src/services/billing-cycle-manual-void.service.js';
import { runManualCycleReconciliationBatch } from '../../src/services/billing-cycle-manual-reconciliation-scheduler.service.js';
import {
  downloadBillingCycleDocument, getBillingCycleDetail, type BillingCycleContext,
} from '../../src/services/billing-cycle-read.service.js';
import type { BillingInvoicePdfStorage } from '../../src/services/billing-invoice-storage.service.js';
import { issueBillingInvoice, voidBillingInvoice } from '../../src/services/billing-invoice-lifecycle.service.js';
import { createTestDb } from '../helpers/test-db.js';

vi.mock('../../src/services/billing-actor.service.js', () => ({
  verifyBillingActor: vi.fn().mockResolvedValue({}),
}));

const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);
type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

class MemoryStorage implements BillingInvoicePdfStorage {
  readonly objects = new Map<string, Buffer>();

  async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    if (this.objects.has(key)) throw new Error('DUPLICATE_TEST_STORAGE_KEY');
    this.objects.set(key, Buffer.from(bytes));
  }

  async read(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) throw new Error('TEST_STORAGE_KEY_MISSING');
    return value;
  }
}

describe.skipIf(!enabled)('issued manual invoice cycle persistence', () => {
  let db: TestDb;
  let storage: MemoryStorage;
  let serviceId: string;
  let serviceIdentifier: string;
  let orgId: string;
  let teamId: string;
  let ownerId: string;
  let tariffId: string;
  let termId: string;
  let invoiceId: string;
  let pendingCycleId: string;
  let finalizedCycleId: string;

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    storage = new MemoryStorage();
    const owner = await db.prisma.user.create({ data: { email: `${randomUUID()}@example.com`,
      userKey: `${randomUUID()}@example.com`, name: 'Owner' } });
    ownerId = owner.id;
    const org = await db.prisma.organisation.create({ data: {
      domain: `${randomUUID()}.example.com`, name: 'Cycle Issuer Test',
      slug: `cycle-${randomUUID().slice(0, 10)}`, ownerId,
    } });
    orgId = org.id;
    const team = await db.prisma.team.create({ data: { orgId, name: 'Selected Team',
      slug: `team-${randomUUID().slice(0, 10)}` } });
    teamId = team.id;
    await db.prisma.orgMember.create({ data: { orgId, userId: ownerId, role: 'owner' } });
    await db.prisma.teamMember.create({ data: { teamId, userId: ownerId, teamRole: 'owner' } });
    const service = await db.prisma.billingService.create({ data: {
      identifier: `cycle-issuer-${randomUUID()}`, name: 'Cycle Issuer Service',
      tariffHistoryFromMonth: '2026-01',
    } });
    serviceId = service.id;
    serviceIdentifier = service.identifier;
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId, key: 'standard', version: 1, name: 'Standard',
      mode: BillingTariffMode.CUSTOM, collectionMode: BillingCollectionMode.MANUAL,
      markupBps: 3000, monthlyAmountMinor: 2000n,
      monthlyChargeBasis: BillingMonthlyChargeBasis.FLAT, currency: 'USD',
    } });
    tariffId = tariff.id;
    const contract = await db.prisma.billingOrganisationContract.create({ data: {
      orgId, reference: `cycle-${randomUUID()}`, name: 'Monthly Agreement',
      createdByEmail: 'admin@example.com',
    } });
    const version = await db.prisma.billingOrganisationContractVersion.create({ data: {
      contractId: contract.id, version: 1, usageMarkupBps: 3000, currency: 'USD',
      paymentTermsDays: 30, effectiveFromMonth: '2026-03',
      createdByEmail: 'admin@example.com',
    } });
    const assignment = await db.prisma.billingTariffAssignment.create({ data: {
      serviceId, tariffId, orgId, teamId: null,
      scope: BillingAssignmentScope.ORGANISATION, scopeKey: orgId,
      createdByEmail: 'admin@example.com',
    } });
    const term = await db.prisma.billingContractServiceTerm.create({ data: {
      contractVersionId: version.id, serviceId, tariffId,
      tariffAssignmentId: assignment.id, monthlyAmountMinor: 2000n,
    } });
    termId = term.id;
    await db.prisma.billingOrganisationContract.update({ where: { id: contract.id },
      data: { status: BillingOrganisationContractStatus.ACTIVE,
        activatedAt: new Date('2026-03-01T00:00:00.000Z') } });
    const issuer = await db.prisma.billingInvoiceIssuerProfile.create({ data: {
      key: `issuer-${randomUUID().slice(0, 10)}`, legalName: 'UOA Ltd',
      billingEmail: 'billing@example.com', address: { country: 'GB', line1: 'One Street' },
      invoiceNumberPrefix: `U${randomUUID().slice(0, 6).toUpperCase()}`,
    } });
    const buyer = await db.prisma.billingOrganisationInvoiceProfile.create({ data: {
      orgId, legalName: 'Customer Ltd', billingEmail: 'ap@example.com',
      billingAddress: { country: 'GB', line1: 'Two Street' },
    } });
    const invoice = await db.prisma.billingInvoice.create({ data: {
      orgId, contractId: contract.id, contractVersionId: version.id,
      issuerProfileId: issuer.id, buyerProfileId: buyer.id,
      billingMonth: '2026-03', revision: 1, status: BillingInvoiceStatus.DRAFT,
      currency: 'USD',
      subtotalMinor: 2000n, totalMinor: 2000n,
      issuerSnapshot: { legal_name: issuer.legalName,
        billing_email: issuer.billingEmail, address: issuer.address },
      buyerSnapshot: { legal_name: buyer.legalName,
        billing_email: buyer.billingEmail, billing_address: buyer.billingAddress },
      calculationDigest: 'c'.repeat(64),
      lines: { create: { serviceId, serviceIdentifier, serviceName: service.name,
        amountMinor: 2000n, currency: 'USD', position: 1 } },
      meteringRefs: { create: { serviceId, ledgerSnapshotCursor: 'issuer-coverage',
        ledgerSnapshotSha256: 'd'.repeat(64),
        capturedAt: new Date('2026-04-01T00:00:00.000Z') } },
    } });
    invoiceId = invoice.id;
    await issueBillingInvoice({ invoiceId, actor: { email: 'admin@example.com' } }, {
      prisma: db.prisma, storage, now: () => new Date('2026-04-01T00:00:00.000Z'),
      authorizeAdminEffect: vi.fn().mockResolvedValue(undefined),
    });
    const source = { kind: 'manual' as const, id: termId };
    const quote = { source, serviceId, tariffId, organisationId: orgId, teamId: null,
      scope: BillingAssignmentScope.ORGANISATION, agreementId: null,
      billingMonth: '2026-03', chargeBasis: BillingMonthlyChargeBasis.FLAT,
      seatPolicy: null, seatChargeTiming: null, amountMinor: 2000n,
      unitAmountMinor: 2000n, uniqueHumanSeats: null, seatMilliseconds: null,
      monthMilliseconds: null, currency: 'USD', baselineCapturedAt: null,
      baselineMemberCount: null, intervals: [], capacityRevisions: [], evidenceIds: [],
      commercialEffectiveAt: null, commercialEndsAt: null, endedAt: null };
    const pending = await prepareBillingCycleClose({ source, billingMonth: '2026-03' }, {
      prisma: db.prisma, now: () => new Date('2026-04-02T00:00:00.000Z'),
      quote: vi.fn().mockResolvedValue(quote),
      discoverTeams: vi.fn().mockResolvedValue({ teamIds: [], snapshot: {
        id: 'empty-team-coverage', cursor: 'empty-team-coverage',
        capturedAt: '2026-04-02T00:00:00.000Z', sha256: 'a'.repeat(64),
      } }),
    });
    pendingCycleId = pending.cycleId;
  });

  afterAll(async () => { await db?.cleanup(); });

  function context(): BillingCycleContext {
    return { credential: { service: { id: serviceId, identifier: serviceIdentifier,
      name: 'Cycle Issuer Service' } } as BillingCycleContext['credential'],
    actorToken: 'test-signed-actor', endpoint: '/billing/v1/cycles/detail',
    request: { product: serviceIdentifier, organisationId: orgId, teamId, userId: ownerId } };
  }

  it('records actual invoice line, immutable legal PDF and credits-only charge breakdown', async () => {
    const result = await captureIssuedManualBillingCycle({ cycleId: pendingCycleId,
      invoiceId }, { prisma: db.prisma, storage });
    finalizedCycleId = result.cycleId;
    const detail = await getBillingCycleDetail(context(), result.cycleId,
      { prisma: db.prisma });
    expect(detail).toMatchObject({ state: 'finalized', document_available: true,
      totals: [{ subscription: { amount_minor: '2000' },
        usage_charge: { amount_minor: '0' }, total_due: { amount_minor: '2000' },
        total_paid: { amount_minor: '0' }, outstanding: { amount_minor: '2000' } }],
      documents: [{ kind: 'monthly_invoice', state: 'available',
        number: expect.stringMatching(/^U[A-Z0-9]+-2026-\d{6}$/) }, { kind: 'usage_breakdown' },
      { kind: 'usage_breakdown' }],
    });
    expect(await db.prisma.billingCustomerCycleInvoiceAllocation.count()).toBe(1);
    expect(await db.prisma.billingCustomerCycleDocument.count()).toBe(3);
    for (const document of detail.documents) {
      const downloaded = await downloadBillingCycleDocument(context(), result.cycleId,
        document.document_id, { prisma: db.prisma, storage });
      expect(downloaded.bytes.length).toBeGreaterThan(0);
      expect(downloaded.bytes.toString()).not.toContain('markup');
      expect(downloaded.bytes.toString()).not.toContain('provider_cost');
    }
    await expect(db.prisma.billingCustomerCycleInvoiceAllocation.updateMany({
      data: { amountMinor: 1000n },
    })).rejects.toThrow();
    expect(await captureIssuedManualBillingCycle({ cycleId: pendingCycleId,
      invoiceId }, { prisma: db.prisma, storage })).toEqual(result);
    expect(await captureIssuedManualBillingCycle({ cycleId: finalizedCycleId,
      invoiceId }, { prisma: db.prisma, storage })).toEqual(result);
    expect(await db.prisma.billingCustomerCycleInvoiceAllocation.count()).toBe(1);
    expect(detail.credits.consumed).toBe('0');
    const csv = detail.documents.find((item) => item.format === 'csv');
    if (!csv) throw new Error('CYCLE_CSV_MISSING');
    const text = (await downloadBillingCycleDocument(context(), result.cycleId,
      csv.document_id, { prisma: db.prisma, storage })).bytes.toString();
    expect(text).toContain('credits_consumed');
    expect(text).not.toMatch(/raw_units|usage_unit|token_count|provider_cost|markup/i);
  });

  it('appends payment evidence without duplicating the legal invoice allocation', async () => {
    await db.prisma.billingInvoicePaymentEvent.create({ data: {
      invoiceId, kind: 'PAYMENT', source: 'MANUAL', amountMinor: 1000n,
      currency: 'USD', idempotencyKey: randomUUID(),
      occurredAt: new Date('2026-04-03T00:00:00.000Z'),
    } });
    const queued = await db.prisma.$queryRaw<Array<{ generation: bigint }>>`
      SELECT generation FROM billing_manual_cycle_reconciliation_queue
      WHERE invoice_id = ${invoiceId}
    `;
    expect(queued).toHaveLength(1);
    expect(queued[0]?.generation).toBeGreaterThan(1n);
    let releaseWork: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const workGate = new Promise<void>((resolve) => { releaseWork = resolve; });
    const firstWorker = runManualCycleReconciliationBatch({
      prisma: db.prisma,
      refreshPayment: async (params) => {
        markStarted?.();
        await workGate;
        return refreshIssuedManualBillingCyclePayment(params, { prisma: db.prisma, storage });
      },
    });
    await started;
    // A second instance cannot claim the in-flight invoice, even after a
    // restart where neither worker retains an in-memory scan cursor.
    const secondWorker = await runManualCycleReconciliationBatch({ prisma: db.prisma });
    expect(secondWorker.checked).toBe(0);
    await db.prisma.billingInvoicePaymentEvent.create({ data: {
      invoiceId, kind: 'PAYMENT', source: 'MANUAL', amountMinor: 500n,
      currency: 'USD', idempotencyKey: randomUUID(),
      occurredAt: new Date('2026-04-04T00:00:00.000Z'),
    } });
    releaseWork?.();
    const caughtUp = await firstWorker;
    expect(caughtUp).toMatchObject({ checked: 1, held: 0 });
    // The in-flight acknowledgment cannot remove a newer committed payment.
    expect(await db.prisma.$queryRaw<Array<{ invoice_id: string }>>`
      SELECT invoice_id FROM billing_manual_cycle_reconciliation_queue
      WHERE invoice_id = ${invoiceId}
    `).toHaveLength(1);
    expect(await runManualCycleReconciliationBatch({ prisma: db.prisma,
      refreshPayment: (params) => refreshIssuedManualBillingCyclePayment(params,
        { prisma: db.prisma, storage }) })).toMatchObject({ checked: 1, held: 0 });
    expect(await db.prisma.$queryRaw<Array<{ invoice_id: string }>>`
      SELECT invoice_id FROM billing_manual_cycle_reconciliation_queue
      WHERE invoice_id = ${invoiceId}
    `).toHaveLength(0);
    const previousId = finalizedCycleId;
    const revised = await refreshIssuedManualBillingCyclePayment({ invoiceId },
      { prisma: db.prisma, storage });
    finalizedCycleId = revised.cycleId;
    const oldDetail = await getBillingCycleDetail(context(), previousId,
      { prisma: db.prisma });
    const newDetail = await getBillingCycleDetail(context(), finalizedCycleId,
      { prisma: db.prisma });
    expect(oldDetail.totals[0]?.outstanding.amount_minor).toBe('2000');
    expect(newDetail.totals[0]?.total_paid.amount_minor).toBe('1500');
    expect(newDetail.totals[0]?.outstanding.amount_minor).toBe('500');
    expect(newDetail.credits.consumed).toBe('0');
    expect(await db.prisma.billingCustomerCycleInvoiceAllocation.count()).toBe(1);
    expect(await db.prisma.billingCustomerCycleDocument.count()).toBe(6);
    expect(await captureIssuedManualBillingCycle({ cycleId: pendingCycleId,
      invoiceId }, { prisma: db.prisma, storage })).toEqual(revised);
    expect(await refreshIssuedManualBillingCyclePayment({ invoiceId },
      { prisma: db.prisma, storage })).toEqual(revised);
  });

  it('denies bytes when org billing authority is revoked during storage read', async () => {
    const detail = await getBillingCycleDetail(context(), finalizedCycleId,
      { prisma: db.prisma });
    const invoiceDocumentId = detail.documents[0]?.document_id;
    if (!invoiceDocumentId) throw new Error('INVOICE_DOCUMENT_MISSING');
    let releaseRead: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const blockedStorage: BillingInvoicePdfStorage = {
      putImmutable: (key, bytes) => storage.putImmutable(key, bytes),
      read: async (key) => {
        markStarted?.();
        await gate;
        return storage.read(key);
      },
    };
    const pending = downloadBillingCycleDocument(context(), finalizedCycleId,
      invoiceDocumentId, { prisma: db.prisma, storage: blockedStorage });
    await started;
    await db.prisma.orgMember.updateMany({ where: { orgId, userId: ownerId },
      data: { role: 'member' } });
    releaseRead?.();
    await expect(pending).rejects.toMatchObject({ statusCode: 403 });
  });

  it('enforces immutable legal party facts on issued invoice rows', async () => {
    await expect(db.prisma.billingInvoice.update({ where: { id: invoiceId },
      data: { buyerSnapshot: { legal_name: 'Altered Customer',
        billing_email: 'ap@example.com' } } })).rejects.toThrow();
  });

  it('catches up an actual void as a new zero-liability cycle without rewriting its legal PDF',
    async () => {
      await db.prisma.orgMember.updateMany({ where: { orgId, userId: ownerId },
        data: { role: 'owner' } });
      const original = await db.prisma.billingInvoice.findUniqueOrThrow({
        where: { id: invoiceId }, include: { lines: true },
      });
      const april = await db.prisma.billingInvoice.create({ data: {
        orgId, contractId: original.contractId,
        contractVersionId: original.contractVersionId,
        issuerProfileId: original.issuerProfileId, buyerProfileId: original.buyerProfileId,
        billingMonth: '2026-04', revision: 1, status: BillingInvoiceStatus.DRAFT,
        currency: 'USD', subtotalMinor: 2000n, totalMinor: 2000n,
        issuerSnapshot: original.issuerSnapshot as object,
        buyerSnapshot: original.buyerSnapshot as object,
        calculationDigest: 'e'.repeat(64),
        lines: { create: { serviceId, serviceIdentifier,
          serviceName: 'Cycle Issuer Service', amountMinor: 2000n,
          currency: 'USD', position: 1 } },
        meteringRefs: { create: { serviceId,
          ledgerSnapshotCursor: 'issuer-april-coverage',
          ledgerSnapshotSha256: 'f'.repeat(64),
          capturedAt: new Date('2026-05-01T00:00:00.000Z') } },
      } });
      await issueBillingInvoice({ invoiceId: april.id,
        actor: { email: 'admin@example.com' } }, { prisma: db.prisma, storage,
        now: () => new Date('2026-05-01T00:00:00.000Z'),
        authorizeAdminEffect: vi.fn().mockResolvedValue(undefined) });
      const source = { kind: 'manual' as const, id: termId };
      const quote = { source, serviceId, tariffId, organisationId: orgId, teamId: null,
        scope: BillingAssignmentScope.ORGANISATION, agreementId: null,
        billingMonth: '2026-04', chargeBasis: BillingMonthlyChargeBasis.FLAT,
        seatPolicy: null, seatChargeTiming: null, amountMinor: 2000n,
        unitAmountMinor: 2000n, uniqueHumanSeats: null, seatMilliseconds: null,
        monthMilliseconds: null, currency: 'USD', baselineCapturedAt: null,
        baselineMemberCount: null, intervals: [], capacityRevisions: [], evidenceIds: [],
        commercialEffectiveAt: null, commercialEndsAt: null, endedAt: null };
      const pending = await prepareBillingCycleClose({ source, billingMonth: '2026-04' }, {
        prisma: db.prisma, now: () => new Date('2026-05-02T00:00:00.000Z'),
        quote: vi.fn().mockResolvedValue(quote),
        discoverTeams: vi.fn().mockResolvedValue({ teamIds: [], snapshot: {
          id: 'empty-april-coverage', cursor: 'empty-april-coverage',
          capturedAt: '2026-05-02T00:00:00.000Z', sha256: 'a'.repeat(64),
        } }),
      });
      const issued = await captureIssuedManualBillingCycle({ cycleId: pending.cycleId,
        invoiceId: april.id }, { prisma: db.prisma, storage });
      const issuedDetail = await getBillingCycleDetail(context(), issued.cycleId,
        { prisma: db.prisma });
      const originalDocument = issuedDetail.documents.find((item) =>
        item.kind === 'monthly_invoice');
      if (!originalDocument) throw new Error('ORIGINAL_INVOICE_DOCUMENT_MISSING');
      const originalBytes = (await downloadBillingCycleDocument(context(), issued.cycleId,
        originalDocument.document_id, { prisma: db.prisma, storage })).bytes;
      await voidBillingInvoice({ invoiceId: april.id, reason: 'Cancelled duplicate issue',
        actor: { email: 'admin@example.com' } }, { prisma: db.prisma,
        now: () => new Date('2026-05-03T00:00:00.000Z'),
        authorizeAdminEffect: vi.fn().mockResolvedValue(undefined) });
      const caughtUp = await runManualCycleReconciliationBatch({
        prisma: db.prisma,
        refreshPayment: (params) => refreshIssuedManualBillingCyclePayment(params,
          { prisma: db.prisma, storage }),
        refreshVoid: (params) => refreshVoidedManualBillingCycle(params,
          { prisma: db.prisma, storage }),
      });
      expect(caughtUp.held, JSON.stringify(caughtUp.failures)).toBe(0);
      const voided = await refreshVoidedManualBillingCycle({ invoiceId: april.id },
        { prisma: db.prisma, storage });
      if (!voided) throw new Error('VOIDED_CYCLE_MISSING');
      const detail = await getBillingCycleDetail(context(), voided.cycleId,
        { prisma: db.prisma });
      expect(detail.state).toBe('voided');
      expect(detail.totals[0]).toMatchObject({ total_due: { amount_minor: '0' },
        total_paid: { amount_minor: '0' }, outstanding: { amount_minor: '0' } });
      expect(issuedDetail.state).toBe('finalized');
      expect(issuedDetail.totals[0]?.total_due.amount_minor).toBe('2000');
      const voidDocument = detail.documents.find((item) =>
        item.kind === 'monthly_invoice');
      if (!voidDocument) throw new Error('VOID_INVOICE_DOCUMENT_MISSING');
      const copied = (await downloadBillingCycleDocument(context(), voided.cycleId,
        voidDocument.document_id, { prisma: db.prisma, storage })).bytes;
      expect(copied).toEqual(originalBytes);
      expect(await db.prisma.billingCustomerCycleInvoiceAllocation.count({ where: {
        sourceInvoiceId: april.id,
      } })).toBe(1);
    });
});
