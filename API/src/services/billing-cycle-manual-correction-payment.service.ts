import { createHash, randomUUID } from 'node:crypto';

import { BillingInvoiceStatus, Prisma, type PrismaClient } from '@prisma/client';

import type { BillingCycleDetailV2, BillingCycleDocument } from
  '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { renderBillingCycleBreakdownCsv, renderBillingCycleBreakdownPdf } from
  './billing-cycle-breakdown.service.js';
import { verifiedManualInvoiceLine } from './billing-cycle-manual-allocation.service.js';
import { copyVerifiedDocument, invoiceSourceFingerprint } from
  './billing-cycle-manual-invoice.service.js';
import { cycleMoney } from './billing-cycle-quote-projection.service.js';
import { billingCycleSnapshotDigest } from './billing-cycle-read.service.js';
import { createBillingInvoicePdfStorage, type BillingInvoicePdfStorage } from
  './billing-invoice-storage.service.js';

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

function paymentDigest(invoice: { id: string; invoiceNumber: string | null;
  pdfSha256: string | null; paymentEvents: Array<{ id: string; kind: string;
    amountMinor: bigint; currency: string; occurredAt: Date }> },
lineId: string, amountMinor: bigint, currency: string): string {
  const events = invoice.paymentEvents.map((row) => ({ id: row.id, kind: row.kind,
    amount_minor: row.amountMinor.toString(), currency: row.currency,
    occurred_at: row.occurredAt.toISOString() }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  return createHash('sha256').update(JSON.stringify({ invoice_id: invoice.id,
    line_id: lineId, invoice_number: invoice.invoiceNumber,
    amount_minor: amountMinor.toString(), currency, pdf_sha256: invoice.pdfSha256,
    payment_events: events })).digest('hex');
}

function acceptedPaid(events: Array<{ kind: string; currency: string;
  amountMinor: bigint }>, currency: string, dueMinor: bigint): bigint {
  let paid = 0n;
  let refunded = 0n;
  for (const event of events) {
    if (event.currency !== currency || event.amountMinor < 0n) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_PAYMENT_INVALID');
    }
    if (event.kind === 'PAYMENT') paid += event.amountMinor;
    else if (event.kind === 'REFUND') refunded += event.amountMinor;
    else hold('BILLING_CYCLE_MANUAL_CORRECTION_PAYMENT_INVALID');
  }
  if (paid > dueMinor || refunded > paid) {
    hold('BILLING_CYCLE_MANUAL_CORRECTION_PAYMENT_INVALID');
  }
  // Refunds are separate verified effects, not a reopened original receivable.
  return paid;
}

/** Revisions preserve accepted cash and legal bytes while showing later
 * payment evidence for the separately issued supplemental invoice. */
export async function refreshIssuedManualCorrectionPayment(params: {
  invoiceId: string;
}, deps?: { prisma?: PrismaClient; storage?: BillingInvoicePdfStorage }):
Promise<{ cycleId: string; snapshotSha256: string }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const storage = deps?.storage ?? createBillingInvoicePdfStorage();
  const [correction, invoice] = await Promise.all([
    prisma.billingCycleManualCorrection.findUnique({ where: {
      supplementInvoiceId: params.invoiceId,
    }, include: { pendingCycle: true } }),
    prisma.billingInvoice.findUnique({ where: { id: params.invoiceId },
      include: { lines: true, paymentEvents: true, lineFinancialAllocations: true,
        creditSettlementRefs: true, lineCreditAllocations: true } }),
  ]);
  if (!correction || !invoice || invoice.status !== BillingInvoiceStatus.ISSUED ||
    invoice.voidedAt || !invoice.pdfSha256) {
    hold('BILLING_CYCLE_MANUAL_CORRECTION_PAYMENT_SOURCE_MISSING');
  }
  const financial = verifiedManualInvoiceLine(invoice,
    correction.pendingCycle.serviceId, correction.pendingCycle.billingMonth);
  const paid = acceptedPaid(invoice.paymentEvents, invoice.currency, financial.allocation.dueMinor);
  const digest = paymentDigest(invoice, financial.line.id,
    financial.allocation.totalMinor, invoice.currency);
  const latest = await prisma.billingCustomerCycle.findFirst({ where: {
    serviceId: correction.pendingCycle.serviceId,
    orgId: correction.pendingCycle.orgId, teamId: correction.pendingCycle.teamId,
    billingMonth: correction.pendingCycle.billingMonth,
  }, include: { documents: true }, orderBy: { revision: 'desc' } });
  const evidence = latest?.privateEvidence as Record<string, unknown> | undefined;
  const allocation = evidence?.invoice_allocation as
    { source_invoice_id?: string; source_line_id?: string; source_digest?: string;
      latest_source_digest?: string } | undefined;
  if (!latest || latest.state !== 'adjusted' ||
    evidence?.correction_source_id !== correction.id ||
    evidence.correction_source_fingerprint !== invoiceSourceFingerprint(invoice) ||
    allocation?.source_invoice_id !== invoice.id ||
    allocation.source_line_id !== financial.line.id ||
    billingCycleSnapshotDigest(latest.publicSnapshot, latest.privateEvidence) !==
      latest.snapshotSha256) hold('BILLING_CYCLE_MANUAL_CORRECTION_PAYMENT_VIEW_CHANGED');
  if ((allocation.latest_source_digest ?? allocation.source_digest) === digest) {
    return { cycleId: latest.id, snapshotSha256: latest.snapshotSha256 };
  }
  const previousPaid = evidence.supplement_paid_minor;
  if (typeof previousPaid !== 'string' || !/^\d+$/.test(previousPaid) ||
    paid < BigInt(previousPaid)) hold('BILLING_CYCLE_MANUAL_CORRECTION_PAYMENT_INVALID');
  const delta = paid - BigInt(previousPaid);
  const prior = latest.publicSnapshot as unknown as BillingCycleDetailV2;
  const currentTotal = prior.totals[0];
  if (!currentTotal || prior.totals.length !== 1 ||
    currentTotal.currency !== invoice.currency ||
    !/^\d+$/.test(currentTotal.outstanding.amount_minor) ||
    BigInt(currentTotal.outstanding.amount_minor) < delta) {
    hold('BILLING_CYCLE_MANUAL_CORRECTION_PAYMENT_TOTAL_INVALID');
  }
  const id = randomUUID();
  const pdfId = randomUUID();
  const csvId = randomUUID();
  const copiedSources = latest.documents.filter((row) => row.kind !== 'usage_breakdown');
  const copied: BillingCycleDocument[] = copiedSources.map((row) => ({
    document_id: randomUUID(), kind: row.kind as BillingCycleDocument['kind'],
    format: row.format as BillingCycleDocument['format'], state: 'available',
    number: row.invoiceNumber, issued_at: row.issuedAt?.toISOString() ?? null,
    customer_total: row.amountMinor === null || !row.currency ? null :
      cycleMoney(row.amountMinor, row.currency), download_action: null,
  }));
  const next: BillingCycleDetailV2 = { ...prior, cycle_id: id,
    totals: [{ ...currentTotal,
      total_paid: cycleMoney(BigInt(currentTotal.total_paid.amount_minor) + delta,
        invoice.currency),
      outstanding: cycleMoney(BigInt(currentTotal.outstanding.amount_minor) - delta,
        invoice.currency) }],
    documents: [...copied,
      { document_id: pdfId, kind: 'usage_breakdown', format: 'pdf', state: 'available',
        number: null, issued_at: new Date().toISOString(), customer_total: null,
        download_action: null },
      { document_id: csvId, kind: 'usage_breakdown', format: 'csv', state: 'available',
        number: null, issued_at: new Date().toISOString(), customer_total: null,
        download_action: null }],
  };
  const nextEvidence = { ...evidence, previous_cycle_id: latest.id,
    supplement_paid_minor: paid.toString(),
    invoice_allocation: { ...allocation, latest_source_digest: digest } };
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
    const source = await tx.billingInvoice.findUnique({ where: { id: invoice.id },
      include: { lines: true, paymentEvents: true, lineFinancialAllocations: true,
        creditSettlementRefs: true, lineCreditAllocations: true } });
    if (current?.id !== latest.id || !source ||
      source.status !== BillingInvoiceStatus.ISSUED || source.voidedAt ||
      invoiceSourceFingerprint(source) !== evidence.correction_source_fingerprint ||
      paymentDigest(source, financial.line.id, financial.allocation.totalMinor,
        invoice.currency) !== digest) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_PAYMENT_SOURCE_CHANGED');
    }
    await tx.billingCustomerCycle.create({ data: { id, serviceId: latest.serviceId,
      orgId: latest.orgId, teamId: latest.teamId, billingMonth: latest.billingMonth,
      revision: latest.revision + 1, state: 'adjusted', payerScope: latest.payerScope,
      publicSnapshot: next as unknown as Prisma.InputJsonValue,
      privateEvidence: nextEvidence as Prisma.InputJsonValue, snapshotSha256 } });
    await tx.billingCustomerCycleDocument.createMany({ data: [
      ...copiedSources.map((row, index) => ({ id: copied[index]?.document_id ??
        hold('BILLING_CYCLE_MANUAL_CORRECTION_DOCUMENT_BINDING'),
      cycleId: id, kind: row.kind, format: row.format, sourceKind: row.sourceKind,
      sourceId: row.sourceId, invoiceNumber: row.invoiceNumber, issuedAt: row.issuedAt,
      amountMinor: row.amountMinor, currency: row.currency,
      objectKey: row.objectKey, sha256: row.sha256 })),
      { id: pdfId, cycleId: id, kind: 'usage_breakdown', format: 'pdf',
        sourceKind: 'cycle', sourceId: id, issuedAt: new Date(next.documents[
          copied.length]?.issued_at ?? hold('BILLING_CYCLE_MANUAL_CORRECTION_DOCUMENT_BINDING')),
        objectKey: `${prefix}/usage.pdf`, sha256: pdfSha },
      { id: csvId, cycleId: id, kind: 'usage_breakdown', format: 'csv',
        sourceKind: 'cycle', sourceId: id, issuedAt: new Date(next.documents[
          copied.length + 1]?.issued_at ?? hold('BILLING_CYCLE_MANUAL_CORRECTION_DOCUMENT_BINDING')),
        objectKey: `${prefix}/usage.csv`, sha256: csvSha },
    ] });
    return { cycleId: id, snapshotSha256 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
