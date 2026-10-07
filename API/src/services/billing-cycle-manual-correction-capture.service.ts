import { createHash, randomUUID } from 'node:crypto';

import { BillingInvoiceStatus, Prisma, type PrismaClient } from '@prisma/client';

import type { BillingCycleDetailV2, BillingCycleDocument } from
  '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { renderBillingCycleBreakdownCsv, renderBillingCycleBreakdownPdf } from
  './billing-cycle-breakdown.service.js';
import { verifyPendingManualCorrectionReceipts } from
  './billing-cycle-manual-correction-prepare.service.js';
import { verifiedManualInvoiceLine } from './billing-cycle-manual-allocation.service.js';
import { copyVerifiedDocument, invoiceSourceFingerprint } from
  './billing-cycle-manual-invoice.service.js';
import { cycleMoney } from './billing-cycle-quote-projection.service.js';
import { billingCycleSnapshotDigest } from './billing-cycle-read.service.js';
import { createBillingInvoicePdfStorage, type BillingInvoicePdfStorage } from
  './billing-invoice-storage.service.js';
import type { CycleUsageEvidence } from './billing-cycle-usage-projection.service.js';
import type { LedgerPaidReceiptSet } from './billing-ledger-paid-receipt-proof.service.js';

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

function hash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function paymentDigest(invoice: { id: string; invoiceNumber: string | null;
  pdfSha256: string | null; paymentEvents: Array<{ id: string; kind: string;
    amountMinor: bigint; currency: string; occurredAt: Date }> },
lineId: string, amountMinor: bigint, currency: string): string {
  const facts = invoice.paymentEvents.map((row) => ({ id: row.id, kind: row.kind,
    amount_minor: row.amountMinor.toString(), currency: row.currency,
    occurred_at: row.occurredAt.toISOString() }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  return hash(JSON.stringify({ invoice_id: invoice.id, line_id: lineId,
    invoice_number: invoice.invoiceNumber, amount_minor: amountMinor.toString(),
    currency, pdf_sha256: invoice.pdfSha256, payment_events: facts }));
}

function sourceDocument(source: { id: string; kind: string; format: string;
  invoiceNumber: string | null; issuedAt: Date | null; amountMinor: bigint | null;
  currency: string | null }): BillingCycleDocument {
  return { document_id: randomUUID(), kind: source.kind as BillingCycleDocument['kind'],
    format: source.format as BillingCycleDocument['format'], state: 'available',
    number: source.invoiceNumber, issued_at: source.issuedAt?.toISOString() ?? null,
    customer_total: source.amountMinor === null || !source.currency ? null :
      cycleMoney(source.amountMinor, source.currency), download_action: null };
}

function added(value: string, delta: bigint, code: string): bigint {
  if (!/^-?(0|[1-9]\d*)$/.test(value)) hold(code);
  const result = BigInt(value) + delta;
  if (result < 0n) hold(code);
  return result;
}

/** Bind only a newly ISSUED delta invoice; original legal bytes and liability
 * remain frozen. The invoice/payment scheduler retries this after failures. */
export async function captureIssuedManualBillingCycleCorrection(params: {
  invoiceId: string;
}, deps?: { prisma?: PrismaClient; storage?: BillingInvoicePdfStorage }):
Promise<{ cycleId: string; snapshotSha256: string }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const storage = deps?.storage ?? createBillingInvoicePdfStorage();
  const correction = await prisma.billingCycleManualCorrection.findUnique({ where: {
    supplementInvoiceId: params.invoiceId,
  }, include: { pendingCycle: true, originalCycle: { include: { documents: true } } } });
  if (!correction || correction.kind !== 'debit') {
    hold('BILLING_CYCLE_MANUAL_CORRECTION_SOURCE_MISSING');
  }
  const { pendingCycle: pending, originalCycle: original } = correction;
  const [invoice, originalLine] = await Promise.all([
    prisma.billingInvoice.findUnique({ where: { id: params.invoiceId },
      include: { lines: true, paymentEvents: true, lineFinancialAllocations: true,
        creditSettlementRefs: true, lineCreditAllocations: true } }),
    prisma.billingInvoiceLine.findUnique({ where: { id: correction.originalLineId },
      include: { invoice: { include: { lines: true, paymentEvents: true,
        lineFinancialAllocations: true, creditSettlementRefs: true,
        lineCreditAllocations: true } } } }),
  ]);
  if (!invoice || !originalLine || !invoice.invoiceNumber || !invoice.issuedAt ||
    !invoice.pdfObjectKey || !invoice.pdfSha256 || invoice.voidedAt ||
    invoice.status !== BillingInvoiceStatus.ISSUED ||
    invoice.orgId !== pending.orgId || invoice.billingMonth !== pending.billingMonth ||
    invoice.currency !== correction.currency ||
    invoice.taxTreatment !== correction.taxTreatment ||
    invoice.taxRateBps !== correction.taxRateBps ||
    invoice.taxLegalBasis !== correction.taxLegalBasis ||
    invoice.calculationDigest !== correction.evidenceDigest ||
    invoiceSourceFingerprint(originalLine.invoice) !== correction.originalSourceDigest ||
    originalLine.invoice.status !== BillingInvoiceStatus.ISSUED ||
    originalLine.invoice.voidedAt) {
    hold('BILLING_CYCLE_MANUAL_CORRECTION_INVOICE_CHANGED');
  }
  const verified = verifiedManualInvoiceLine(invoice, pending.serviceId, pending.billingMonth);
  if (invoice.lines.length !== 1 || verified.allocation.subscriptionMinor !== 0n ||
    verified.allocation.usageMinor !== correction.netDeltaMinor ||
    verified.allocation.taxMinor !== correction.taxDeltaMinor ||
    verified.allocation.invoiceCreditMinor !== correction.creditDeltaMinor ||
    verified.allocation.totalMinor !== correction.netDeltaMinor + correction.taxDeltaMinor) {
    hold('BILLING_CYCLE_MANUAL_CORRECTION_LINE_CHANGED');
  }
  let paid = 0n;
  let refunded = 0n;
  for (const event of invoice.paymentEvents) {
    if (event.currency !== invoice.currency || event.amountMinor < 0n) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_PAYMENT_UNALLOCATABLE');
    }
    if (event.kind === 'PAYMENT') paid += event.amountMinor;
    else if (event.kind === 'REFUND') refunded += event.amountMinor;
    else hold('BILLING_CYCLE_MANUAL_CORRECTION_PAYMENT_UNALLOCATABLE');
  }
  if (paid > verified.allocation.dueMinor || refunded > paid) {
    hold('BILLING_CYCLE_MANUAL_CORRECTION_PAYMENT_UNALLOCATABLE');
  }
  const current = pending.publicSnapshot as unknown as BillingCycleDetailV2;
  const prior = original.publicSnapshot as unknown as BillingCycleDetailV2;
  const evidence = pending.privateEvidence as Record<string, unknown> & {
    ledger_snapshots?: CycleUsageEvidence[];
    paid_receipt_proofs?: LedgerPaidReceiptSet[];
  };
  const priorEvidence = original.privateEvidence as Record<string, unknown>;
  const quote = evidence.quote as { tariff_id?: string } | undefined;
  if (pending.state !== 'pending_reconciliation' ||
    (original.state !== 'finalized' && original.state !== 'adjusted') ||
    current.correction_of_cycle_id !== original.id ||
    !quote?.tariff_id || prior.totals.length !== 1 ||
    prior.totals[0]?.currency !== invoice.currency ||
    billingCycleSnapshotDigest(pending.publicSnapshot, pending.privateEvidence) !==
      pending.snapshotSha256 ||
    billingCycleSnapshotDigest(original.publicSnapshot, original.privateEvidence) !==
      original.snapshotSha256) hold('BILLING_CYCLE_MANUAL_CORRECTION_CYCLE_CHANGED');
  const latest = await prisma.billingCustomerCycle.findFirst({ where: {
    serviceId: pending.serviceId, orgId: pending.orgId,
    teamId: pending.teamId, billingMonth: pending.billingMonth,
  }, orderBy: { revision: 'desc' } });
  if (latest?.id !== pending.id) {
    const observed = latest?.privateEvidence as Record<string, unknown> | undefined;
    if (observed?.previous_cycle_id === pending.id && latest?.state === 'adjusted' &&
      billingCycleSnapshotDigest(latest.publicSnapshot, latest.privateEvidence) ===
        latest.snapshotSha256) {
      const allocation = observed.invoice_allocation as
        { source_digest?: string; latest_source_digest?: string } | undefined;
      const currentDigest = paymentDigest(invoice, verified.line.id,
        verified.allocation.totalMinor, invoice.currency);
      if ((allocation?.latest_source_digest ?? allocation?.source_digest) === currentDigest) {
        return { cycleId: latest.id, snapshotSha256: latest.snapshotSha256 };
      }
      const { refreshIssuedManualCorrectionPayment } = await import(
        './billing-cycle-manual-correction-payment.service.js');
      return refreshIssuedManualCorrectionPayment({ invoiceId: invoice.id }, deps);
    }
    hold('BILLING_CYCLE_MANUAL_CORRECTION_REVISION_CHANGED');
  }
  const bytes = await storage.read(invoice.pdfObjectKey);
  if (bytes.length < 5 || bytes.length > MAX_DOCUMENT_BYTES ||
    bytes.subarray(0, 5).toString('ascii') !== '%PDF-' ||
    hash(bytes) !== invoice.pdfSha256) hold('BILLING_CYCLE_MANUAL_CORRECTION_PDF_INVALID');
  const id = randomUUID();
  const legalId = randomUUID();
  const pdfId = randomUUID();
  const csvId = randomUUID();
  const amount = correction.netDeltaMinor + correction.taxDeltaMinor;
  const total = prior.totals[0] ?? hold('BILLING_CYCLE_MANUAL_CORRECTION_TOTAL_MISSING');
  const copiedSources = original.documents.filter((row) => row.kind !== 'usage_breakdown');
  const copied = copiedSources.map(sourceDocument);
  const documents: BillingCycleDocument[] = [...copied,
    { document_id: legalId, kind: 'monthly_invoice', format: 'pdf', state: 'available',
      number: invoice.invoiceNumber, issued_at: invoice.issuedAt.toISOString(),
      customer_total: cycleMoney(amount, invoice.currency), download_action: null },
    { document_id: pdfId, kind: 'usage_breakdown', format: 'pdf', state: 'available',
      number: null, issued_at: invoice.issuedAt.toISOString(), customer_total: null,
      download_action: null },
    { document_id: csvId, kind: 'usage_breakdown', format: 'csv', state: 'available',
      number: null, issued_at: invoice.issuedAt.toISOString(), customer_total: null,
      download_action: null }];
  const next: BillingCycleDetailV2 = { ...current, cycle_id: id, state: 'adjusted',
    totals: [{ ...total,
      usage_charge: cycleMoney(added(total.usage_charge.amount_minor,
        correction.netDeltaMinor, 'BILLING_CYCLE_MANUAL_CORRECTION_TOTAL_INVALID'), invoice.currency),
      tax: cycleMoney(added(total.tax.amount_minor, correction.taxDeltaMinor,
        'BILLING_CYCLE_MANUAL_CORRECTION_TOTAL_INVALID'), invoice.currency),
      gross_total: cycleMoney(added(total.gross_total.amount_minor, amount,
        'BILLING_CYCLE_MANUAL_CORRECTION_TOTAL_INVALID'), invoice.currency),
      credits_applied: cycleMoney(added(total.credits_applied.amount_minor,
        correction.creditDeltaMinor,
        'BILLING_CYCLE_MANUAL_CORRECTION_TOTAL_INVALID'), invoice.currency),
      total_due: cycleMoney(added(total.total_due.amount_minor,
        amount - correction.creditDeltaMinor,
        'BILLING_CYCLE_MANUAL_CORRECTION_TOTAL_INVALID'), invoice.currency),
      total_paid: cycleMoney(added(total.total_paid.amount_minor, paid,
        'BILLING_CYCLE_MANUAL_CORRECTION_TOTAL_INVALID'), invoice.currency),
      outstanding: cycleMoney(added(total.outstanding.amount_minor,
        amount - correction.creditDeltaMinor - paid,
        'BILLING_CYCLE_MANUAL_CORRECTION_TOTAL_INVALID'), invoice.currency),
    }], documents, document_available: true,
    adjustments: [...prior.adjustments, { source_cycle_id: original.id,
      document_id: legalId, kind: 'charge',
      customer_amount: cycleMoney(amount, invoice.currency),
      reason: 'Additional settled usage from the closed billing month' }] };
  const authorityKey = hash(`manual\0${invoice.id}\0${verified.line.id}`);
  const sourceDigest = paymentDigest(invoice, verified.line.id,
    verified.allocation.totalMinor, invoice.currency);
  const nextEvidence = { ...evidence, previous_cycle_id: pending.id,
    primary_invoice_allocation: priorEvidence.primary_invoice_allocation ??
      priorEvidence.invoice_allocation,
    invoice_source_fingerprint: priorEvidence.invoice_source_fingerprint,
    correction_source_id: correction.id,
    correction_source_fingerprint: invoiceSourceFingerprint(invoice),
    supplement_paid_minor: paid.toString(),
    invoice_allocation: { authority_key: authorityKey, source_kind: 'manual',
      source_invoice_id: invoice.id, source_line_id: verified.line.id,
      source_digest: sourceDigest } };
  const snapshotSha256 = billingCycleSnapshotDigest(next, nextEvidence);
  const prefix = `billing-cycles/${id}`;
  const [legalSha, pdf, csv] = await Promise.all([
    copyVerifiedDocument(storage, `${prefix}/supplement.pdf`, bytes, 'application/pdf'),
    renderBillingCycleBreakdownPdf(next),
    Promise.resolve(renderBillingCycleBreakdownCsv(next)),
  ]);
  const [pdfSha, csvSha] = await Promise.all([
    copyVerifiedDocument(storage, `${prefix}/usage.pdf`, pdf, 'application/pdf'),
    copyVerifiedDocument(storage, `${prefix}/usage.csv`, csv, 'text/csv'),
  ]);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations
      WHERE id = ${pending.orgId} FOR UPDATE`);
    const latestLocked = await tx.billingCustomerCycle.findFirst({ where: {
      serviceId: pending.serviceId, orgId: pending.orgId,
      teamId: pending.teamId, billingMonth: pending.billingMonth,
    }, orderBy: { revision: 'desc' } });
    if (latestLocked?.id !== pending.id) hold('BILLING_CYCLE_MANUAL_CORRECTION_REVISION_CHANGED');
    const [currentInvoice, currentOriginal] = await Promise.all([
      tx.billingInvoice.findUnique({ where: { id: invoice.id },
        include: { lines: true, paymentEvents: true, lineFinancialAllocations: true,
          creditSettlementRefs: true, lineCreditAllocations: true } }),
      tx.billingInvoice.findUnique({ where: { id: originalLine.invoiceId },
        include: { lines: true, paymentEvents: true, lineFinancialAllocations: true,
          creditSettlementRefs: true, lineCreditAllocations: true } }),
    ]);
    if (!currentInvoice || currentInvoice.status !== BillingInvoiceStatus.ISSUED ||
      currentInvoice.voidedAt || !currentOriginal ||
      invoiceSourceFingerprint(currentInvoice) !== nextEvidence.correction_source_fingerprint ||
      paymentDigest(currentInvoice, verified.line.id,
        verified.allocation.totalMinor, invoice.currency) !== sourceDigest ||
      invoiceSourceFingerprint(currentOriginal) !== correction.originalSourceDigest) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_INVOICE_CHANGED');
    }
    await verifyPendingManualCorrectionReceipts(tx, pending, current, evidence,
      String(quote.tariff_id));
    await tx.billingCustomerCycle.create({ data: { id, serviceId: pending.serviceId,
      orgId: pending.orgId, teamId: pending.teamId, billingMonth: pending.billingMonth,
      revision: pending.revision + 1, state: 'adjusted', payerScope: pending.payerScope,
      publicSnapshot: next as unknown as Prisma.InputJsonValue,
      privateEvidence: nextEvidence as Prisma.InputJsonValue, snapshotSha256 } });
    const startsAt = new Date(`${pending.billingMonth}-01T00:00:00.000Z`);
    const endsAt = new Date(Date.UTC(startsAt.getUTCFullYear(),
      startsAt.getUTCMonth() + 1, 1));
    await tx.billingCustomerCycleInvoiceAllocation.create({ data: { cycleId: id,
      authorityKey, sourceKind: 'manual', sourceInvoiceId: invoice.id,
      sourceLineId: verified.line.id, periodStartsAt: startsAt, periodEndsAt: endsAt,
      amountMinor: amount, currency: invoice.currency, sourceDigest } });
    await tx.billingCustomerCycleDocument.createMany({ data: [
      ...copiedSources.map((row, index) => ({ id: copied[index]?.document_id ??
        hold('BILLING_CYCLE_MANUAL_CORRECTION_DOCUMENT_BINDING'),
      cycleId: id, kind: row.kind, format: row.format, sourceKind: row.sourceKind,
      sourceId: row.sourceId, invoiceNumber: row.invoiceNumber, issuedAt: row.issuedAt,
      amountMinor: row.amountMinor, currency: row.currency,
      objectKey: row.objectKey, sha256: row.sha256 })),
      { id: legalId, cycleId: id, kind: 'monthly_invoice', format: 'pdf',
        sourceKind: 'manual_invoice', sourceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber, issuedAt: invoice.issuedAt,
        amountMinor: amount, currency: invoice.currency,
        objectKey: `${prefix}/supplement.pdf`, sha256: legalSha },
      { id: pdfId, cycleId: id, kind: 'usage_breakdown', format: 'pdf',
        sourceKind: 'cycle', sourceId: id, issuedAt: invoice.issuedAt,
        objectKey: `${prefix}/usage.pdf`, sha256: pdfSha },
      { id: csvId, cycleId: id, kind: 'usage_breakdown', format: 'csv',
        sourceKind: 'cycle', sourceId: id, issuedAt: invoice.issuedAt,
        objectKey: `${prefix}/usage.csv`, sha256: csvSha },
    ] });
    return { cycleId: id, snapshotSha256 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
