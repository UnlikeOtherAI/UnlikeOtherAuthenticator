import { createHash, randomUUID } from 'node:crypto';

import { BillingInvoiceStatus, Prisma, type PrismaClient } from '@prisma/client';

import type { BillingCycleDetailV2, BillingCycleDocument } from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { renderBillingCycleBreakdownCsv, renderBillingCycleBreakdownPdf } from './billing-cycle-breakdown.service.js';
import { billingCycleSnapshotDigest } from './billing-cycle-read.service.js';
import { verifiedManualInvoiceLine } from './billing-cycle-manual-allocation.service.js';
import {
  createBillingInvoicePdfStorage, type BillingInvoicePdfStorage,
} from './billing-invoice-storage.service.js';
import { cycleMoney } from './billing-cycle-quote-projection.service.js';
import { copyVerifiedDocument, invoiceSourceFingerprint } from './billing-cycle-manual-invoice.service.js';

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function paymentFacts(events: Array<{ id: string; kind: string;
  amountMinor: bigint; currency: string; occurredAt: Date }>) {
  return events.map((event) => ({ id: event.id, kind: event.kind,
    amount_minor: event.amountMinor.toString(), currency: event.currency,
    occurred_at: event.occurredAt.toISOString() }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
}

function paymentTotal(events: Array<{ kind: string; amountMinor: bigint;
  currency: string }>, currency: string, invoiceTotal: bigint): bigint {
  let paid = 0n;
  let refunded = 0n;
  for (const event of events) {
    if (event.currency !== currency || event.amountMinor < 0n ||
      event.kind === 'WRITE_OFF') hold('BILLING_CYCLE_MANUAL_PAYMENT_UNALLOCATABLE');
    if (event.kind === 'PAYMENT') paid += event.amountMinor;
    else if (event.kind === 'REFUND') refunded += event.amountMinor;
    else hold('BILLING_CYCLE_MANUAL_PAYMENT_UNALLOCATABLE');
  }
  if (paid > invoiceTotal || refunded > paid) {
    hold('BILLING_CYCLE_MANUAL_PAYMENT_UNALLOCATABLE');
  }
  return paid;
}

/** Payment/refund changes append a new view; invoice allocation and legal PDF stay fixed. */
async function refreshOneManualBillingCyclePayment(
  params: { invoiceId: string; authorityKey: string },
  deps?: { prisma?: PrismaClient; storage?: BillingInvoicePdfStorage },
): Promise<{ cycleId: string; snapshotSha256: string }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const storage = deps?.storage ?? createBillingInvoicePdfStorage();
  const [allocation, invoice] = await Promise.all([
    prisma.billingCustomerCycleInvoiceAllocation.findUnique({ where: {
      authorityKey: params.authorityKey,
    }, include: { cycle: true } }),
    prisma.billingInvoice.findUnique({ where: { id: params.invoiceId },
      include: { lines: true, paymentEvents: true, lineFinancialAllocations: true,
        creditSettlementRefs: true, lineCreditAllocations: true } }),
  ]);
  if (!invoice || !allocation || allocation.sourceKind !== 'manual' ||
    allocation.sourceInvoiceId !== params.invoiceId) hold('BILLING_CYCLE_MANUAL_ALLOCATION_MISSING');
  const selected = verifiedManualInvoiceLine(invoice, allocation.cycle.serviceId,
    allocation.cycle.billingMonth);
  const line = invoice.lines.find((item) => item.id === allocation.sourceLineId);
  if (invoice.status !== BillingInvoiceStatus.ISSUED || !line ||
    line.id !== selected.line.id || line.serviceId !== allocation.cycle.serviceId ||
    selected.allocation.totalMinor !== allocation.amountMinor ||
    line.currency !== allocation.currency ||
    invoice.pdfSha256 === null || invoice.pdfObjectKey === null ||
    invoice.orgId !== allocation.cycle.orgId ||
    invoice.billingMonth !== allocation.cycle.billingMonth) {
    hold('BILLING_CYCLE_MANUAL_ALLOCATION_CHANGED');
  }
  const sourceDigest = sha256(JSON.stringify({ invoice_id: invoice.id,
    line_id: line.id, invoice_number: invoice.invoiceNumber,
    amount_minor: selected.allocation.totalMinor.toString(), currency: invoice.currency,
    pdf_sha256: invoice.pdfSha256, payment_events: paymentFacts(invoice.paymentEvents) }));
  const paid = paymentTotal(invoice.paymentEvents, invoice.currency, selected.invoiceDueMinor);
  if (!selected.soleProduct && paid !== 0n && paid !== selected.invoiceDueMinor) {
    hold('BILLING_CYCLE_MANUAL_PAYMENT_UNALLOCATABLE');
  }
  const linePaid = selected.soleProduct ? paid : paid === 0n ? 0n : selected.allocation.dueMinor;
  const latest = await prisma.billingCustomerCycle.findFirst({ where: {
    serviceId: allocation.cycle.serviceId, orgId: allocation.cycle.orgId,
    teamId: allocation.cycle.teamId, billingMonth: allocation.cycle.billingMonth,
  }, include: { documents: true }, orderBy: { revision: 'desc' } });
  if (!latest || latest.state !== 'finalized' ||
    billingCycleSnapshotDigest(latest.publicSnapshot, latest.privateEvidence) !==
      latest.snapshotSha256) hold('BILLING_CYCLE_MANUAL_LATEST_RECONCILIATION_REQUIRED');
  const evidence = latest.privateEvidence as Record<string, unknown>;
  const invoiceEvidence = evidence.invoice_allocation as Record<string, unknown> | undefined;
  if (invoiceEvidence?.authority_key !== allocation.authorityKey ||
    invoiceEvidence.source_invoice_id !== invoice.id ||
    evidence.invoice_source_fingerprint !== invoiceSourceFingerprint(invoice)) {
    hold('BILLING_CYCLE_MANUAL_LATEST_RECONCILIATION_REQUIRED');
  }
  if (invoiceEvidence.latest_source_digest === sourceDigest ||
    (invoiceEvidence.latest_source_digest === undefined &&
      invoiceEvidence.source_digest === sourceDigest)) {
    return { cycleId: latest.id, snapshotSha256: latest.snapshotSha256 };
  }
  const originalInvoiceDocument = latest.documents.find((item) =>
    item.kind === 'monthly_invoice' && item.format === 'pdf' &&
    item.sourceKind === 'manual_invoice' && item.sourceId === invoice.id);
  if ((selected.soleProduct && (!originalInvoiceDocument ||
    originalInvoiceDocument.sha256 !== invoice.pdfSha256 ||
    originalInvoiceDocument.invoiceNumber !== invoice.invoiceNumber ||
    originalInvoiceDocument.amountMinor !== invoice.totalMinor)) ||
    (!selected.soleProduct && originalInvoiceDocument)) {
    hold('BILLING_CYCLE_MANUAL_DOCUMENT_RECONCILIATION_REQUIRED');
  }
  const id = randomUUID();
  const invoiceDocId = randomUUID();
  const usagePdfId = randomUUID();
  const usageCsvId = randomUUID();
  const prior = latest.publicSnapshot as unknown as BillingCycleDetailV2;
  const documents: BillingCycleDocument[] = prior.documents.map((item) => ({
    ...item, document_id: item.kind === 'monthly_invoice' ? invoiceDocId :
      item.format === 'pdf' ? usagePdfId : usageCsvId,
    download_action: null,
  }));
  const next: BillingCycleDetailV2 = { ...prior, cycle_id: id,
    totals: prior.totals.map((total) => ({ ...total,
      total_paid: cycleMoney(linePaid, invoice.currency),
      outstanding: cycleMoney(selected.allocation.dueMinor - linePaid, invoice.currency),
    })), documents };
  const nextEvidence = { ...evidence, previous_cycle_id: latest.id,
    invoice_source_fingerprint: invoiceSourceFingerprint(invoice),
    invoice_allocation: { ...invoiceEvidence, latest_source_digest: sourceDigest } };
  const snapshotSha256 = billingCycleSnapshotDigest(next, nextEvidence);
  const prefix = `billing-cycles/${id}`;
  const [pdf, csv] = await Promise.all([
    renderBillingCycleBreakdownPdf(next),
    Promise.resolve(renderBillingCycleBreakdownCsv(next)),
  ]);
  const [pdfSha, csvSha] = await Promise.all([
    copyVerifiedDocument(storage, `${prefix}/usage.pdf`, pdf, 'application/pdf'),
    copyVerifiedDocument(storage, `${prefix}/usage.csv`, csv, 'text/csv'),
  ]);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations
      WHERE id = ${latest.orgId} FOR UPDATE`);
    const current = await tx.billingCustomerCycle.findFirst({ where: {
      serviceId: latest.serviceId, orgId: latest.orgId,
      teamId: latest.teamId, billingMonth: latest.billingMonth,
    }, orderBy: { revision: 'desc' } });
    if (current?.id !== latest.id) hold('BILLING_CYCLE_PAYMENT_REVISION_CHANGED');
    const currentInvoice = await tx.billingInvoice.findUnique({
      where: { id: invoice.id }, include: { lines: true, paymentEvents: true,
        lineFinancialAllocations: true, creditSettlementRefs: true,
        lineCreditAllocations: true },
    });
    const currentLine = currentInvoice?.lines.find((item) => item.id === line.id);
    if (!currentInvoice || currentInvoice.status !== BillingInvoiceStatus.ISSUED ||
      currentInvoice.voidedAt || currentInvoice.orgId !== invoice.orgId ||
      invoiceSourceFingerprint(currentInvoice) !== invoiceSourceFingerprint(invoice) ||
      currentInvoice.contractVersionId !== invoice.contractVersionId ||
      currentInvoice.billingMonth !== invoice.billingMonth ||
      currentInvoice.currency !== invoice.currency ||
      currentInvoice.totalMinor !== invoice.totalMinor ||
      currentInvoice.pdfSha256 !== invoice.pdfSha256 ||
      currentInvoice.pdfObjectKey !== invoice.pdfObjectKey ||
      currentInvoice.invoiceNumber !== invoice.invoiceNumber ||
      !currentLine ||
      currentLine.id !== line.id || currentLine.amountMinor !== line.amountMinor ||
      currentLine.serviceId !== line.serviceId ||
      JSON.stringify(paymentFacts(currentInvoice.paymentEvents)) !==
      JSON.stringify(paymentFacts(invoice.paymentEvents))) {
      hold('BILLING_CYCLE_MANUAL_SOURCE_CHANGED');
    }
    await tx.billingCustomerCycle.create({ data: {
      id, serviceId: latest.serviceId, orgId: latest.orgId, teamId: latest.teamId,
      billingMonth: latest.billingMonth, revision: latest.revision + 1,
      state: 'finalized', payerScope: latest.payerScope,
      publicSnapshot: next as unknown as Prisma.InputJsonValue,
      privateEvidence: nextEvidence as Prisma.InputJsonValue, snapshotSha256,
    } });
    await tx.billingCustomerCycleDocument.createMany({ data: [
      ...(originalInvoiceDocument ? [{ id: invoiceDocId, cycleId: id,
        kind: 'monthly_invoice', format: 'pdf',
        sourceKind: 'manual_invoice', sourceId: invoice.id,
        invoiceNumber: originalInvoiceDocument.invoiceNumber,
        issuedAt: originalInvoiceDocument.issuedAt,
        amountMinor: originalInvoiceDocument.amountMinor,
        currency: originalInvoiceDocument.currency,
        objectKey: originalInvoiceDocument.objectKey,
        sha256: originalInvoiceDocument.sha256 }] : []),
      { id: usagePdfId, cycleId: id, kind: 'usage_breakdown', format: 'pdf',
        sourceKind: 'cycle', sourceId: id, issuedAt: invoice.issuedAt,
        objectKey: `${prefix}/usage.pdf`, sha256: pdfSha },
      { id: usageCsvId, cycleId: id, kind: 'usage_breakdown', format: 'csv',
        sourceKind: 'cycle', sourceId: id, issuedAt: invoice.issuedAt,
        objectKey: `${prefix}/usage.csv`, sha256: csvSha },
    ] });
    return { cycleId: id, snapshotSha256 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/** One issuer event can affect several frozen product lines. Process each
 * allocation separately and acknowledge the durable queue only if all pass. */
export async function refreshIssuedManualBillingCyclePayment(
  params: { invoiceId: string },
  deps?: { prisma?: PrismaClient; storage?: BillingInvoicePdfStorage },
): Promise<{ cycleId: string; snapshotSha256: string }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const rows = await prisma.billingCustomerCycleInvoiceAllocation.findMany({ where: {
    sourceKind: 'manual', sourceInvoiceId: params.invoiceId,
  }, orderBy: { authorityKey: 'asc' }, select: { authorityKey: true } });
  if (rows.length === 0) hold('BILLING_CYCLE_MANUAL_ALLOCATION_MISSING');
  let result: { cycleId: string; snapshotSha256: string } | undefined;
  for (const row of rows) {
    result = await refreshOneManualBillingCyclePayment({ ...params,
      authorityKey: row.authorityKey }, deps);
  }
  if (!result) hold('BILLING_CYCLE_MANUAL_ALLOCATION_MISSING');
  return result;
}
