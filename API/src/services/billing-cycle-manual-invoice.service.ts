import { createHash, randomUUID } from 'node:crypto';

import { BillingInvoiceStatus, Prisma, type PrismaClient } from '@prisma/client';

import type { BillingCycleDetailV2, BillingCycleDocument } from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { renderBillingCycleBreakdownCsv, renderBillingCycleBreakdownPdf } from './billing-cycle-breakdown.service.js';
import { cycleMoney } from './billing-cycle-quote-projection.service.js';
import { billingCycleSnapshotDigest } from './billing-cycle-read.service.js';
import {
  createBillingInvoicePdfStorage, type BillingInvoicePdfStorage,
} from './billing-invoice-storage.service.js';
import {
  addBillingDecimals, majorAmountToMinorRounded,
} from './billing-money.service.js';

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
type IssuedInvoice = Prisma.BillingInvoiceGetPayload<{
  include: { lines: true; paymentEvents: true };
}>;

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function paymentFacts(events: Array<{ id: string; kind: string;
  amountMinor: bigint; currency: string; occurredAt: Date }>) {
  return events.map((event) => ({ id: event.id, kind: event.kind,
    amount_minor: event.amountMinor.toString(), currency: event.currency,
    occurred_at: event.occurredAt.toISOString() }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function invoiceSourceFingerprint(invoice: IssuedInvoice): string {
  return digest(JSON.stringify({
    id: invoice.id, org_id: invoice.orgId, contract_id: invoice.contractId,
    contract_version_id: invoice.contractVersionId, billing_month: invoice.billingMonth,
    invoice_number: invoice.invoiceNumber, issue_date: invoice.issueDate?.toISOString() ?? null,
    issued_at: invoice.issuedAt?.toISOString() ?? null,
    currency: invoice.currency, subtotal_minor: invoice.subtotalMinor.toString(),
    tax_minor: invoice.taxAmountMinor.toString(),
    credits_minor: invoice.creditsAppliedMinor.toString(),
    total_minor: invoice.totalMinor.toString(),
    issuer_snapshot: invoice.issuerSnapshot, buyer_snapshot: invoice.buyerSnapshot,
    calculation_digest: invoice.calculationDigest,
    pdf_key: invoice.pdfObjectKey, pdf_sha256: invoice.pdfSha256,
    lines: invoice.lines.map((line) => ({ id: line.id, service_id: line.serviceId,
      amount_minor: line.amountMinor.toString(), currency: line.currency,
      position: line.position })).sort((a, b) => a.id.localeCompare(b.id)),
  }));
}

function legalParty(value: Prisma.JsonValue): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).legal_name === 'string' &&
    Boolean((value as Record<string, unknown>).legal_name);
}

export async function copyVerifiedDocument(
  storage: BillingInvoicePdfStorage, key: string, bytes: Buffer,
  contentType: 'application/pdf' | 'text/csv',
): Promise<string> {
  if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES) {
    hold('BILLING_CYCLE_DOCUMENT_SIZE_INVALID');
  }
  const sha256 = digest(bytes);
  try {
    await storage.putImmutable(key, bytes, contentType);
  } catch (error) {
    if (!(error instanceof AppError) ||
      error.message !== 'BILLING_INVOICE_PDF_ALREADY_EXISTS') throw error;
    const recorded = await storage.read(key);
    if (digest(recorded) !== sha256) hold('BILLING_CYCLE_DOCUMENT_REPLAY_CONFLICT');
  }
  return sha256;
}

function document(id: string, kind: BillingCycleDocument['kind'],
  format: BillingCycleDocument['format'], invoiceNumber: string | null,
  issuedAt: Date | null, amountMinor: bigint | null, currency: string,
): BillingCycleDocument {
  return { document_id: id, kind, format, state: 'available',
    number: invoiceNumber, issued_at: issuedAt?.toISOString() ?? null,
    customer_total: amountMinor === null ? null : cycleMoney(amountMinor, currency),
    download_action: null };
}

/**
 * Records only an actually issued UOA manual invoice with one exact service
 * line. Ambiguous multi-service payment/credit/tax allocations remain held.
 * The original legal invoice and a separate measured breakdown are immutable.
 */
export async function captureIssuedManualBillingCycle(
  params: { cycleId: string; invoiceId: string },
  deps?: { prisma?: PrismaClient; storage?: BillingInvoicePdfStorage },
): Promise<{ cycleId: string; snapshotSha256: string }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const storage = deps?.storage ?? createBillingInvoicePdfStorage();
  const [cycle, invoice] = await Promise.all([
    prisma.billingCustomerCycle.findUnique({ where: { id: params.cycleId } }),
    prisma.billingInvoice.findUnique({ where: { id: params.invoiceId },
      include: { lines: true, paymentEvents: true } }),
  ]);
  if (!cycle || !invoice) hold('BILLING_CYCLE_ISSUED_SOURCE_MISSING');
  const existingLine = invoice.lines[0];
  if (existingLine) {
    const key = digest(`manual\0${invoice.id}\0${existingLine.id}`);
    const existing = await prisma.billingCustomerCycleInvoiceAllocation.findUnique({
      where: { authorityKey: key }, include: { cycle: true },
    });
    if (existing) {
      if (existing.cycle.orgId !== cycle.orgId || existing.cycle.serviceId !== cycle.serviceId ||
        existing.cycle.billingMonth !== cycle.billingMonth ||
        existing.cycle.teamId !== cycle.teamId ||
        invoice.status !== BillingInvoiceStatus.ISSUED || invoice.voidedAt ||
        invoice.lines.length !== 1 || existingLine.serviceId !== cycle.serviceId ||
        existingLine.amountMinor !== existing.amountMinor ||
        existingLine.currency !== existing.currency ||
        billingCycleSnapshotDigest(existing.cycle.publicSnapshot,
          existing.cycle.privateEvidence) !== existing.cycle.snapshotSha256) {
        hold('BILLING_CYCLE_INVOICE_ALLOCATION_CONFLICT');
      }
      // Return the latest immutable view of this one allocated liability.
      // A new payment/refund is captured as another view by the payment worker.
      const latest = await prisma.billingCustomerCycle.findFirst({ where: {
        orgId: cycle.orgId, serviceId: cycle.serviceId, teamId: cycle.teamId,
        billingMonth: cycle.billingMonth,
      }, orderBy: { revision: 'desc' } });
      const latestEvidence = latest?.privateEvidence as Record<string, unknown> | undefined;
      const allocation = latestEvidence?.invoice_allocation as Record<string, unknown> | undefined;
      if (!latest || allocation?.authority_key !== key ||
        latestEvidence?.invoice_source_fingerprint !== invoiceSourceFingerprint(invoice) ||
        billingCycleSnapshotDigest(latest.publicSnapshot, latest.privateEvidence) !==
          latest.snapshotSha256) hold('BILLING_CYCLE_INVOICE_ALLOCATION_CONFLICT');
      const sourceDigest = digest(JSON.stringify({ invoice_id: invoice.id,
        line_id: existingLine.id, invoice_number: invoice.invoiceNumber,
        amount_minor: existingLine.amountMinor.toString(), currency: invoice.currency,
        pdf_sha256: invoice.pdfSha256, payment_events: paymentFacts(invoice.paymentEvents) }));
      if ((allocation.latest_source_digest ?? allocation.source_digest) !== sourceDigest) {
        const { refreshIssuedManualBillingCyclePayment } =
          await import('./billing-cycle-manual-payment.service.js');
        return refreshIssuedManualBillingCyclePayment({ invoiceId: invoice.id }, deps);
      }
      return { cycleId: latest.id, snapshotSha256: latest.snapshotSha256 };
    }
  }
  if (billingCycleSnapshotDigest(cycle.publicSnapshot, cycle.privateEvidence) !==
    cycle.snapshotSha256) hold('BILLING_CYCLE_SNAPSHOT_INTEGRITY');
  const pending = cycle.publicSnapshot as unknown as BillingCycleDetailV2;
  const privateEvidence = cycle.privateEvidence as Record<string, unknown>;
  const quote = privateEvidence.quote as Record<string, unknown> | undefined;
  const source = quote?.source as { kind?: string; id?: string } | undefined;
  if (cycle.state !== 'pending_reconciliation' || !quote || source?.kind !== 'manual' ||
    typeof source.id !== 'string' || quote.service_id !== cycle.serviceId ||
    quote.organisation_id !== cycle.orgId || quote.team_id !== cycle.teamId ||
    quote.billing_month !== cycle.billingMonth ||
    pending.cycle_id !== cycle.id || pending.state !== cycle.state ||
    pending.product.id !== cycle.serviceId || pending.scope.team_id !== cycle.teamId) {
    hold('BILLING_CYCLE_MANUAL_SOURCE_MISMATCH');
  }
  const term = await prisma.billingContractServiceTerm.findUnique({
    where: { id: source.id }, select: { serviceId: true, contractVersionId: true },
  });
  const line = invoice.lines[0];
  if (!term || term.serviceId !== cycle.serviceId ||
    term.contractVersionId !== invoice.contractVersionId ||
    invoice.orgId !== cycle.orgId || invoice.billingMonth !== cycle.billingMonth ||
    cycle.teamId !== null || invoice.status !== BillingInvoiceStatus.ISSUED ||
    invoice.lines.length !== 1 || !line || line.serviceId !== cycle.serviceId ||
    line.currency !== invoice.currency || invoice.currency !== quote.currency ||
    invoice.creditsAppliedMinor !== 0n || invoice.taxAmountMinor !== 0n ||
    invoice.subtotalMinor !== line.amountMinor || invoice.totalMinor !== line.amountMinor ||
    !invoice.invoiceNumber || !invoice.issuedAt || !invoice.issueDate ||
    !invoice.pdfObjectKey || !invoice.pdfSha256 ||
    !legalParty(invoice.issuerSnapshot) || !legalParty(invoice.buyerSnapshot)) {
    hold('BILLING_CYCLE_MANUAL_INVOICE_ALLOCATION_UNPROVEN');
  }
  const subscriptionMinor = BigInt(String(quote.amount_minor));
  const usageAmount = pending.usage_lines.reduce((total, usage) =>
    addBillingDecimals(total, usage.customer_charge?.amount ?? '0'), '0');
  const creditEvidence = privateEvidence.credit_evidence;
  if (usageAmount !== '0' && (!Array.isArray(creditEvidence) ||
    pending.credits.consumed === null || creditEvidence.some((item) => !item ||
      item.covered !== true || item.funded_debit_microcredits !== '0'))) {
    // This strict one-line issuer path cannot demand payment again for usage
    // already funded by wallet credits. A broader line allocation must bind
    // the actual settlement references before finalization.
    hold('BILLING_CYCLE_MANUAL_CREDIT_ALLOCATION_UNPROVEN');
  }
  if (pending.usage_lines.some((usage) => usage.customer_charge === null) ||
    pending.subscription_lines.length !== 1 ||
    pending.subscription_lines[0]?.customer_charge.amount_minor !==
      subscriptionMinor.toString() ||
    line.amountMinor !== subscriptionMinor +
      majorAmountToMinorRounded(usageAmount, invoice.currency)) {
    hold('BILLING_CYCLE_MANUAL_AMOUNT_MISMATCH');
  }
  let totalPaid = 0n;
  for (const event of invoice.paymentEvents) {
    if (event.currency !== invoice.currency || event.amountMinor < 0n ||
      event.kind === 'WRITE_OFF') hold('BILLING_CYCLE_MANUAL_PAYMENT_UNALLOCATABLE');
    totalPaid += event.kind === 'PAYMENT' ? event.amountMinor : -event.amountMinor;
  }
  if (totalPaid < 0n || totalPaid > invoice.totalMinor) {
    hold('BILLING_CYCLE_MANUAL_PAYMENT_UNALLOCATABLE');
  }
  const invoiceBytes = await storage.read(invoice.pdfObjectKey);
  if (invoiceBytes.length === 0 || invoiceBytes.length > MAX_DOCUMENT_BYTES ||
    invoiceBytes.subarray(0, 5).toString('ascii') !== '%PDF-' ||
    digest(invoiceBytes) !== invoice.pdfSha256) hold('BILLING_CYCLE_ISSUED_PDF_INTEGRITY');

  const sourceFingerprint = invoiceSourceFingerprint(invoice);

  const allocationKey = digest(`manual\0${invoice.id}\0${line.id}`);
  const sourceDigest = digest(JSON.stringify({ invoice_id: invoice.id,
    line_id: line.id, invoice_number: invoice.invoiceNumber,
    amount_minor: line.amountMinor.toString(), currency: invoice.currency,
    pdf_sha256: invoice.pdfSha256, payment_events: paymentFacts(invoice.paymentEvents) }));
  const priorAllocation = await prisma.billingCustomerCycleInvoiceAllocation.findUnique({
    where: { authorityKey: allocationKey }, include: { cycle: true },
  });
  if (priorAllocation) {
    const priorEvidence = priorAllocation.cycle.privateEvidence as Record<string, unknown>;
    if (priorAllocation.sourceDigest !== sourceDigest ||
      priorEvidence.previous_cycle_id !== cycle.id ||
      billingCycleSnapshotDigest(priorAllocation.cycle.publicSnapshot,
        priorAllocation.cycle.privateEvidence) !== priorAllocation.cycle.snapshotSha256) {
      hold('BILLING_CYCLE_INVOICE_ALLOCATION_CONFLICT');
    }
    return { cycleId: priorAllocation.cycleId,
      snapshotSha256: priorAllocation.cycle.snapshotSha256 };
  }

  const id = randomUUID();
  const invoiceDocumentId = randomUUID();
  const breakdownPdfId = randomUUID();
  const breakdownCsvId = randomUUID();
  const next: BillingCycleDetailV2 = { ...pending, cycle_id: id, state: 'finalized',
    totals: [{ currency: invoice.currency,
      subscription: cycleMoney(subscriptionMinor, invoice.currency),
      usage_charge: cycleMoney(majorAmountToMinorRounded(usageAmount, invoice.currency), invoice.currency),
      credits_applied: cycleMoney(0n, invoice.currency),
      total_due: cycleMoney(invoice.totalMinor, invoice.currency),
      total_paid: cycleMoney(totalPaid, invoice.currency),
      outstanding: cycleMoney(invoice.totalMinor - totalPaid, invoice.currency) }],
    credits: pending.credits,
    document_available: true,
    documents: [
      document(invoiceDocumentId, 'monthly_invoice', 'pdf', invoice.invoiceNumber,
        invoice.issuedAt, invoice.totalMinor, invoice.currency),
      document(breakdownPdfId, 'usage_breakdown', 'pdf', null,
        invoice.issuedAt, null, invoice.currency),
      document(breakdownCsvId, 'usage_breakdown', 'csv', null,
        invoice.issuedAt, null, invoice.currency),
    ] };
  const evidence = { ...privateEvidence, previous_cycle_id: cycle.id,
    invoice_source_fingerprint: sourceFingerprint,
    invoice_allocation: { authority_key: allocationKey,
      source_kind: 'manual', source_invoice_id: invoice.id,
      source_line_id: line.id, source_digest: sourceDigest } };
  const snapshotSha256 = billingCycleSnapshotDigest(next, evidence);
  const prefix = `billing-cycles/${id}`;
  const [invoiceSha, breakdownPdf, breakdownCsv] = await Promise.all([
    copyVerifiedDocument(storage, `${prefix}/invoice.pdf`, invoiceBytes, 'application/pdf'),
    renderBillingCycleBreakdownPdf(next),
    Promise.resolve(renderBillingCycleBreakdownCsv(next)),
  ]);
  const [pdfSha, csvSha] = await Promise.all([
    copyVerifiedDocument(storage, `${prefix}/usage.pdf`, breakdownPdf, 'application/pdf'),
    copyVerifiedDocument(storage, `${prefix}/usage.csv`, breakdownCsv, 'text/csv'),
  ]);
  const startsAt = new Date(`${cycle.billingMonth}-01T00:00:00.000Z`);
  const endsAt = new Date(Date.UTC(startsAt.getUTCFullYear(), startsAt.getUTCMonth() + 1, 1));
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations
      WHERE id = ${cycle.orgId} FOR UPDATE`);
    const latest = await tx.billingCustomerCycle.findFirst({ where: {
      serviceId: cycle.serviceId, orgId: cycle.orgId,
      teamId: cycle.teamId, billingMonth: cycle.billingMonth,
    }, orderBy: { revision: 'desc' } });
    if (latest?.id !== cycle.id) hold('BILLING_CYCLE_SOURCE_REVISION_CHANGED');
    const [currentInvoice, currentTerm] = await Promise.all([
      tx.billingInvoice.findUnique({ where: { id: invoice.id },
        include: { lines: true, paymentEvents: true } }),
      tx.billingContractServiceTerm.findUnique({ where: { id: source.id },
        select: { serviceId: true, contractVersionId: true } }),
    ]);
    if (!currentInvoice || currentInvoice.status !== BillingInvoiceStatus.ISSUED ||
      currentInvoice.voidedAt || invoiceSourceFingerprint(currentInvoice) !== sourceFingerprint ||
      currentTerm?.serviceId !== term.serviceId ||
      currentTerm?.contractVersionId !== term.contractVersionId) {
      hold('BILLING_CYCLE_MANUAL_SOURCE_CHANGED');
    }
    await tx.billingCustomerCycle.create({ data: {
      id, serviceId: cycle.serviceId, orgId: cycle.orgId,
      teamId: cycle.teamId, billingMonth: cycle.billingMonth,
      revision: cycle.revision + 1, state: 'finalized', payerScope: cycle.payerScope,
      publicSnapshot: next as unknown as Prisma.InputJsonValue,
      privateEvidence: evidence as Prisma.InputJsonValue, snapshotSha256,
    } });
    await tx.billingCustomerCycleInvoiceAllocation.create({ data: {
      cycleId: id, authorityKey: allocationKey, sourceKind: 'manual',
      sourceInvoiceId: invoice.id, sourceLineId: line.id,
      periodStartsAt: startsAt, periodEndsAt: endsAt,
      amountMinor: line.amountMinor, currency: invoice.currency, sourceDigest,
    } });
    await tx.billingCustomerCycleDocument.createMany({ data: [
      { id: invoiceDocumentId, cycleId: id, kind: 'monthly_invoice', format: 'pdf',
        sourceKind: 'manual_invoice', sourceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber, issuedAt: invoice.issuedAt,
        amountMinor: invoice.totalMinor, currency: invoice.currency,
        objectKey: `${prefix}/invoice.pdf`, sha256: invoiceSha },
      { id: breakdownPdfId, cycleId: id, kind: 'usage_breakdown', format: 'pdf',
        sourceKind: 'cycle', sourceId: id, issuedAt: invoice.issuedAt,
        objectKey: `${prefix}/usage.pdf`, sha256: pdfSha },
      { id: breakdownCsvId, cycleId: id, kind: 'usage_breakdown', format: 'csv',
        sourceKind: 'cycle', sourceId: id, issuedAt: invoice.issuedAt,
        objectKey: `${prefix}/usage.csv`, sha256: csvSha },
    ] });
    return { cycleId: id, snapshotSha256 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
