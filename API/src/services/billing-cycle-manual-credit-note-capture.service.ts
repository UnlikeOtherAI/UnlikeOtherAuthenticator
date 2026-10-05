import { createHash, randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

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

function cash(events: Array<{ kind: string; amountMinor: bigint; currency: string }>,
  currency: string, due: bigint): { paid: bigint; refunded: bigint } {
  let paid = 0n;
  let refunded = 0n;
  for (const event of events) {
    if (event.currency !== currency || event.amountMinor < 0n) {
      hold('BILLING_CREDIT_NOTE_CASH_UNPROVEN');
    }
    if (event.kind === 'PAYMENT') paid += event.amountMinor;
    else if (event.kind === 'REFUND') refunded += event.amountMinor;
    else hold('BILLING_CREDIT_NOTE_CASH_UNPROVEN');
  }
  if (paid === 0n || paid > due || refunded > paid) {
    hold('BILLING_CREDIT_NOTE_CASH_UNPROVEN');
  }
  return { paid, refunded };
}

function copiedDocument(row: { id: string; kind: string; format: string;
  invoiceNumber: string | null; issuedAt: Date | null; amountMinor: bigint | null;
  currency: string | null }): BillingCycleDocument {
  return { document_id: randomUUID(), kind: row.kind as BillingCycleDocument['kind'],
    format: row.format as BillingCycleDocument['format'], state: 'available',
    number: row.invoiceNumber, issued_at: row.issuedAt?.toISOString() ?? null,
    customer_total: row.amountMinor === null || !row.currency ? null :
      cycleMoney(row.amountMinor, row.currency), download_action: null };
}

/** Applies the legal cancellation note, preserving the original invoice and
 * accepted cash. Later verified refunds append another view of the same note. */
export async function captureIssuedManualCreditNote(params: { creditNoteId: string },
  deps?: { prisma?: PrismaClient; storage?: BillingInvoicePdfStorage }):
Promise<{ cycleId: string; snapshotSha256: string }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const storage = deps?.storage ?? createBillingInvoicePdfStorage();
  const note = await prisma.billingManualCreditNote.findUnique({ where: {
    id: params.creditNoteId,
  }, include: { originalCycle: { include: { documents: true } },
    originalInvoice: { include: { lines: true, paymentEvents: true,
      lineFinancialAllocations: true, creditSettlementRefs: true,
      lineCreditAllocations: true } } } });
  if (!note || note.status !== 'ISSUED' || !note.creditNoteNumber ||
    !note.issuedAt || !note.pdfObjectKey || !note.pdfSha256 ||
    note.originalInvoice.status !== 'ISSUED' || note.originalInvoice.voidedAt ||
    invoiceSourceFingerprint(note.originalInvoice) !== note.originalSourceDigest) {
    hold('BILLING_CREDIT_NOTE_SOURCE_UNPROVEN');
  }
  const original = note.originalCycle;
  if (original.state !== 'finalized' || original.teamId !== null ||
    original.serviceId !== note.serviceId || original.orgId !== note.orgId ||
    original.billingMonth !== note.billingMonth ||
    billingCycleSnapshotDigest(original.publicSnapshot, original.privateEvidence) !==
      original.snapshotSha256) hold('BILLING_CREDIT_NOTE_ORIGINAL_UNPROVEN');
  const allocation = verifiedManualInvoiceLine(note.originalInvoice,
    note.serviceId, note.billingMonth);
  if (!allocation.soleProduct || allocation.allocation.invoiceCreditMinor !== 0n ||
    allocation.allocation.totalMinor !== note.totalCreditMinor ||
    allocation.allocation.subscriptionMinor + allocation.allocation.usageMinor !==
      note.netCreditMinor || allocation.allocation.taxMinor !== note.taxCreditMinor ||
    note.originalInvoice.creditsAppliedMinor !== 0n) {
    hold('BILLING_CREDIT_NOTE_FINANCIAL_SOURCE_UNPROVEN');
  }
  const { paid, refunded } = cash(note.originalInvoice.paymentEvents,
    note.currency, note.totalCreditMinor);
  const latest = await prisma.billingCustomerCycle.findFirst({ where: {
    serviceId: note.serviceId, orgId: note.orgId, teamId: null,
    billingMonth: note.billingMonth,
  }, include: { documents: true }, orderBy: { revision: 'desc' } });
  if (!latest || billingCycleSnapshotDigest(latest.publicSnapshot, latest.privateEvidence) !==
    latest.snapshotSha256) hold('BILLING_CREDIT_NOTE_REVISION_UNPROVEN');
  const latestEvidence = latest.privateEvidence as Record<string, unknown>;
  if (latest.id !== original.id && (latest.state !== 'voided' ||
    latestEvidence.credit_note_id !== note.id)) {
    hold('BILLING_CREDIT_NOTE_REVISION_CONFLICT');
  }
  if (latest.id !== original.id && latestEvidence.accepted_paid_minor === paid.toString() &&
    latestEvidence.verified_refunded_minor === refunded.toString()) {
    return { cycleId: latest.id, snapshotSha256: latest.snapshotSha256 };
  }
  const noteBytes = await storage.read(note.pdfObjectKey);
  if (noteBytes.length < 5 || noteBytes.length > 20 * 1024 * 1024 ||
    noteBytes.subarray(0, 5).toString('ascii') !== '%PDF-' ||
    createHash('sha256').update(noteBytes).digest('hex') !== note.pdfSha256) {
    hold('BILLING_CREDIT_NOTE_PDF_INVALID');
  }
  const originalDetail = original.publicSnapshot as unknown as BillingCycleDetailV2;
  const originalTotal = originalDetail.totals[0];
  if (!originalTotal || originalDetail.totals.length !== 1 ||
    originalTotal.currency !== note.currency ||
    originalTotal.gross_total.amount_minor !== note.totalCreditMinor.toString() ||
    originalTotal.total_due.amount_minor !== note.totalCreditMinor.toString() ||
    originalTotal.credits_applied.amount_minor !== '0') {
    hold('BILLING_CREDIT_NOTE_ORIGINAL_TOTAL_UNPROVEN');
  }
  const id = randomUUID();
  const legalId = randomUUID();
  const pdfId = randomUUID();
  const csvId = randomUUID();
  const copiedSources = latest.documents.filter((row) => row.kind !== 'usage_breakdown' &&
    row.sourceKind !== 'manual_credit_note');
  const copied = copiedSources.map(copiedDocument);
  const noteDocument: BillingCycleDocument = { document_id: legalId, kind: 'credit_note',
    format: 'pdf', state: 'available', number: note.creditNoteNumber,
    issued_at: note.issuedAt.toISOString(),
    customer_total: cycleMoney(note.totalCreditMinor, note.currency), download_action: null };
  const currentDetail = latest.publicSnapshot as unknown as BillingCycleDetailV2;
  const next: BillingCycleDetailV2 = { ...currentDetail, cycle_id: id,
    correction_of_cycle_id: latest.id, state: 'voided',
    totals: [{ ...originalTotal,
      subscription: cycleMoney(0n, note.currency),
      usage_charge: cycleMoney(0n, note.currency), tax: cycleMoney(0n, note.currency),
      gross_total: cycleMoney(0n, note.currency),
      credits_applied: cycleMoney(0n, note.currency),
      total_due: cycleMoney(0n, note.currency),
      total_paid: cycleMoney(paid, note.currency),
      outstanding: cycleMoney(0n, note.currency),
      customer_credit_due: cycleMoney(paid - refunded, note.currency),
    }], document_available: true,
    documents: [...copied, noteDocument,
      { document_id: pdfId, kind: 'usage_breakdown', format: 'pdf',
        state: 'available', number: null, issued_at: note.issuedAt.toISOString(),
        customer_total: null, download_action: null },
      { document_id: csvId, kind: 'usage_breakdown', format: 'csv',
        state: 'available', number: null, issued_at: note.issuedAt.toISOString(),
        customer_total: null, download_action: null }],
    adjustments: latest.id === original.id ? [...originalDetail.adjustments,
      { source_cycle_id: original.id, document_id: legalId, kind: 'credit',
        customer_amount: cycleMoney(note.totalCreditMinor, note.currency),
        reason: 'Issuer cancellation of original manual invoice' }] :
      currentDetail.adjustments.map((item) => item.kind === 'credit' &&
        item.source_cycle_id === original.id ?
        { ...item, document_id: legalId } : item),
  };
  const privateEvidence = { ...(latest.privateEvidence as Record<string, unknown>),
    previous_cycle_id: latest.id, credit_note_id: note.id,
    credit_note_sha256: note.pdfSha256, accepted_paid_minor: paid.toString(),
    verified_refunded_minor: refunded.toString(),
    original_invoice_source_digest: note.originalSourceDigest };
  const snapshotSha256 = billingCycleSnapshotDigest(next, privateEvidence);
  const prefix = `billing-cycles/${id}`;
  const [pdf, csv] = await Promise.all([renderBillingCycleBreakdownPdf(next),
    Promise.resolve(renderBillingCycleBreakdownCsv(next))]);
  const [legalSha, pdfSha, csvSha] = await Promise.all([
    copyVerifiedDocument(storage, `${prefix}/credit-note.pdf`, noteBytes, 'application/pdf'),
    copyVerifiedDocument(storage, `${prefix}/usage.pdf`, pdf, 'application/pdf'),
    copyVerifiedDocument(storage, `${prefix}/usage.csv`, csv, 'text/csv'),
  ]);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations
      WHERE id = ${note.orgId} FOR UPDATE`);
    const [current, source] = await Promise.all([
      tx.billingCustomerCycle.findFirst({ where: { serviceId: note.serviceId,
        orgId: note.orgId, teamId: null, billingMonth: note.billingMonth },
      orderBy: { revision: 'desc' } }),
      tx.billingInvoice.findUnique({ where: { id: note.originalInvoiceId },
        include: { lines: true, paymentEvents: true, lineFinancialAllocations: true,
          creditSettlementRefs: true, lineCreditAllocations: true } }),
    ]);
    if (current?.id !== latest.id || !source || source.status !== 'ISSUED' ||
      source.voidedAt || invoiceSourceFingerprint(source) !== note.originalSourceDigest) {
      hold('BILLING_CREDIT_NOTE_SOURCE_CHANGED');
    }
    const actual = cash(source.paymentEvents, note.currency, note.totalCreditMinor);
    if (actual.paid !== paid || actual.refunded !== refunded) {
      hold('BILLING_CREDIT_NOTE_CASH_CHANGED');
    }
    await tx.billingCustomerCycle.create({ data: { id, serviceId: note.serviceId,
      orgId: note.orgId, teamId: null, billingMonth: note.billingMonth,
      revision: latest.revision + 1, state: 'voided', payerScope: latest.payerScope,
      publicSnapshot: next as unknown as Prisma.InputJsonValue,
      privateEvidence: privateEvidence as Prisma.InputJsonValue, snapshotSha256 } });
    await tx.billingCustomerCycleDocument.createMany({ data: [
      ...copiedSources.map((row, index) => ({ id: copied[index]?.document_id ??
        hold('BILLING_CREDIT_NOTE_DOCUMENT_BINDING'), cycleId: id,
      kind: row.kind, format: row.format, sourceKind: row.sourceKind,
      sourceId: row.sourceId, invoiceNumber: row.invoiceNumber,
      issuedAt: row.issuedAt, amountMinor: row.amountMinor, currency: row.currency,
      objectKey: row.objectKey, sha256: row.sha256 })),
      { id: legalId, cycleId: id, kind: 'credit_note', format: 'pdf',
        sourceKind: 'manual_credit_note', sourceId: note.id,
        invoiceNumber: note.creditNoteNumber, issuedAt: note.issuedAt,
        amountMinor: note.totalCreditMinor, currency: note.currency,
        objectKey: `${prefix}/credit-note.pdf`, sha256: legalSha },
      { id: pdfId, cycleId: id, kind: 'usage_breakdown', format: 'pdf',
        sourceKind: 'cycle', sourceId: id, issuedAt: note.issuedAt,
        objectKey: `${prefix}/usage.pdf`, sha256: pdfSha },
      { id: csvId, cycleId: id, kind: 'usage_breakdown', format: 'csv',
        sourceKind: 'cycle', sourceId: id, issuedAt: note.issuedAt,
        objectKey: `${prefix}/usage.csv`, sha256: csvSha },
    ] });
    return { cycleId: id, snapshotSha256 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
