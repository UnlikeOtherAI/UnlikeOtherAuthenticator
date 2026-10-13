import { BillingAssignmentScope, BillingInvoiceStatus, BillingMonthlyChargeBasis } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { prepareBillingCycleClose } from '../../src/services/billing-cycle-close.service.js';
import { captureIssuedManualBillingCycle, invoiceSourceFingerprint } from '../../src/services/billing-cycle-manual-invoice.service.js';
import { refreshIssuedManualBillingCyclePayment } from '../../src/services/billing-cycle-manual-payment.service.js';
import { runManualCycleReconciliationBatch } from '../../src/services/billing-cycle-manual-reconciliation-scheduler.service.js';
import { refreshVoidedManualBillingCycle } from '../../src/services/billing-cycle-manual-void.service.js';
import { downloadBillingCycleDocument, getBillingCycleDetail } from '../../src/services/billing-cycle-read.service.js';
import { issueBillingInvoice, voidBillingInvoice } from '../../src/services/billing-invoice-lifecycle.service.js';
import type { BillingInvoicePdfStorage } from '../../src/services/billing-invoice-storage.service.js';
import { exportBillingConformanceFixture } from '../helpers/billing-conformance-export.js';
import { context, db, enabled, finalizedCycleId, invoiceId, orgId, ownerId, pendingCycleId, rememberFinalizedCycle, serviceId, serviceIdentifier, setupIssuedCycleFixture, storage, tariffId, termId } from '../helpers/issued-cycle-fixture.js';
import { registerMultiServiceTaxAllocationCase } from './billing-cycle-tax-allocation.cases.js';
vi.mock('../../src/services/billing-actor.service.js', () => ({
  verifyBillingActor: vi.fn().mockResolvedValue({}),
}));

describe.skipIf(!enabled)('issued manual invoice cycle persistence', () => {
  setupIssuedCycleFixture();

  it('keeps an initially unallocated issued invoice queued across failed projection and restart', async () => {
    const queued = await db.prisma.$queryRaw<Array<{ invoice_id: string }>>`
      SELECT invoice_id FROM billing_manual_cycle_reconciliation_queue
      WHERE invoice_id = ${invoiceId}
    `;
    expect(queued).toHaveLength(1);
    expect(await runManualCycleReconciliationBatch({ prisma: db.prisma,
      prepareClose: vi.fn().mockRejectedValue(new Error('temporary Ledger outage')),
    })).toMatchObject({ checked: 1, held: 1 });
    expect(await db.prisma.billingCustomerCycleInvoiceAllocation.count()).toBe(0);
    await db.prisma.$executeRaw`
      UPDATE billing_manual_cycle_reconciliation_queue SET due_at = now()
      WHERE invoice_id = ${invoiceId}
    `;
    const prepared = vi.fn().mockResolvedValue({ cycleId: pendingCycleId });
    const recovered = await runManualCycleReconciliationBatch({ prisma: db.prisma,
      prepareClose: prepared,
      captureIssued: (params) => captureIssuedManualBillingCycle(params,
        { prisma: db.prisma, storage }),
      refreshPayment: (params) => refreshIssuedManualBillingCyclePayment(params,
        { prisma: db.prisma, storage }),
    });
    expect(recovered.held, JSON.stringify(recovered.failures)).toBe(0);
    expect(prepared).toHaveBeenCalledOnce();
    expect(prepared.mock.calls[0]?.[0]).toEqual({
      source: { kind: 'manual', id: termId }, billingMonth: '2026-03',
    });
    expect(await db.prisma.billingCustomerCycleInvoiceAllocation.count()).toBe(1);
    // Capture commits a newer queue generation while the first worker holds
    // its lease; that worker cannot acknowledge away the follow-up event.
    expect(await runManualCycleReconciliationBatch({ prisma: db.prisma,
      refreshPayment: (params) => refreshIssuedManualBillingCyclePayment(params,
        { prisma: db.prisma, storage }),
    })).toMatchObject({ checked: 1, held: 0 });
    expect(await db.prisma.$queryRaw<Array<{ invoice_id: string }>>`
      SELECT invoice_id FROM billing_manual_cycle_reconciliation_queue
      WHERE invoice_id = ${invoiceId}
    `).toHaveLength(0);
  });

  it('records actual invoice line, immutable legal PDF and credits-only charge breakdown', async () => {
    const frozen = await db.prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId },
      include: { lines: true, paymentEvents: true, lineFinancialAllocations: true,
        creditSettlementRefs: true, lineCreditAllocations: true } });
    expect(invoiceSourceFingerprint({ ...frozen,
      lineFinancialAllocations: frozen.lineFinancialAllocations.map((line) => ({
        ...line, dueMinor: line.dueMinor + 1n,
      })) })).not.toBe(invoiceSourceFingerprint(frozen));
    const result = await captureIssuedManualBillingCycle({ cycleId: pendingCycleId,
      invoiceId }, { prisma: db.prisma, storage });
    rememberFinalizedCycle(result.cycleId);
    const detail = await getBillingCycleDetail(context(), result.cycleId,
      { prisma: db.prisma });
    await exportBillingConformanceFixture(`${serviceIdentifier}-finalized-manual-cycle`, detail);
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
    expect(queued[0]?.generation).toBeGreaterThanOrEqual(1n);
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
    rememberFinalizedCycle(revised.cycleId);
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

  registerMultiServiceTaxAllocationCase();

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
      const aprilLine = await db.prisma.billingInvoiceLine.findFirstOrThrow({
        where: { invoiceId: april.id },
      });
      await db.prisma.billingInvoiceLineFinancialAllocation.create({ data: {
        lineId: aprilLine.id, invoiceId: april.id, serviceId,
        billingMonth: '2026-04', subscriptionMinor: 2000n, usageMinor: 0n,
        taxMinor: 0n, invoiceCreditMinor: 0n, totalMinor: 2000n,
        dueMinor: 2000n, currency: 'USD', calculationDigest: 'e'.repeat(64),
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
