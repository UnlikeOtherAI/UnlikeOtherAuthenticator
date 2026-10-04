import { createHash, randomUUID } from 'node:crypto';

import { BillingInvoiceStatus, Prisma, type PrismaClient } from '@prisma/client';

import type { BillingCycleDetailV2, BillingCycleDocument } from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { renderBillingCycleBreakdownCsv,
  renderBillingCycleBreakdownPdf } from './billing-cycle-breakdown.service.js';
import { copyVerifiedDocument,
  invoiceSourceFingerprint } from './billing-cycle-manual-invoice.service.js';
import { cycleMoney } from './billing-cycle-quote-projection.service.js';
import { billingCycleSnapshotDigest } from './billing-cycle-read.service.js';
import { createBillingInvoicePdfStorage,
  type BillingInvoicePdfStorage } from './billing-invoice-storage.service.js';

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** An actual issuer void creates a new customer view and preserves the issued PDF. */
export async function refreshVoidedManualBillingCycle(
  params: { invoiceId: string },
  deps?: { prisma?: PrismaClient; storage?: BillingInvoicePdfStorage },
): Promise<{ cycleId: string; snapshotSha256: string } | null> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const storage = deps?.storage ?? createBillingInvoicePdfStorage();
  const allocation = await prisma.billingCustomerCycleInvoiceAllocation.findFirst({
    where: { sourceKind: 'manual', sourceInvoiceId: params.invoiceId },
    include: { cycle: true },
  });
  if (!allocation) return null;
  const invoice = await prisma.billingInvoice.findUnique({
    where: { id: params.invoiceId },
    include: { lines: true, paymentEvents: true,
      _count: { select: { creditSettlementRefs: true } } },
  });
  if (!invoice || invoice.status !== BillingInvoiceStatus.VOID || !invoice.voidedAt ||
    invoice.paymentEvents.length !== 0 || invoice._count.creditSettlementRefs !== 0 ||
    invoice.lines.length !== 1 || invoice.lines[0]?.id !== allocation.sourceLineId ||
    invoice.orgId !== allocation.cycle.orgId ||
    invoice.billingMonth !== allocation.cycle.billingMonth ||
    invoice.lines[0]?.serviceId !== allocation.cycle.serviceId) {
    hold('BILLING_CYCLE_VOID_SOURCE_UNPROVEN');
  }
  const voidedAt = invoice.voidedAt;
  const latest = await prisma.billingCustomerCycle.findFirst({ where: {
    orgId: allocation.cycle.orgId, serviceId: allocation.cycle.serviceId,
    teamId: allocation.cycle.teamId, billingMonth: allocation.cycle.billingMonth,
  }, include: { documents: true }, orderBy: { revision: 'desc' } });
  if (!latest || billingCycleSnapshotDigest(latest.publicSnapshot,
    latest.privateEvidence) !== latest.snapshotSha256) hold('BILLING_CYCLE_VOID_PRIOR_INVALID');
  const evidence = latest.privateEvidence as Record<string, unknown>;
  const effect = evidence.invoice_allocation as Record<string, unknown> | undefined;
  const voidFacts = { invoice_id: invoice.id, voided_at: voidedAt.toISOString(),
    reason_sha256: hash(invoice.voidReason ?? '') };
  if (effect?.authority_key !== allocation.authorityKey ||
    evidence.invoice_source_fingerprint !== invoiceSourceFingerprint(invoice)) {
    hold('BILLING_CYCLE_VOID_PRIOR_INVALID');
  }
  if (latest.state === 'voided') {
    const recorded = evidence.voided_invoice as Record<string, unknown> | undefined;
    if (recorded?.invoice_id !== voidFacts.invoice_id ||
      recorded.voided_at !== voidFacts.voided_at ||
      recorded.reason_sha256 !== voidFacts.reason_sha256) {
      hold('BILLING_CYCLE_VOID_REPLAY_CONFLICT');
    }
    return { cycleId: latest.id, snapshotSha256: latest.snapshotSha256 };
  }
  if (latest.state !== 'finalized') hold('BILLING_CYCLE_VOID_PRIOR_INVALID');
  const original = latest.documents.find((document) => document.kind === 'monthly_invoice' &&
    document.format === 'pdf' && document.sourceKind === 'manual_invoice' &&
    document.sourceId === invoice.id);
  if (!original || original.sha256 !== invoice.pdfSha256 ||
    original.objectKey === null || original.amountMinor !== invoice.totalMinor ||
    original.invoiceNumber !== invoice.invoiceNumber) {
    hold('BILLING_CYCLE_VOID_DOCUMENT_INVALID');
  }
  const id = randomUUID();
  const invoiceDocumentId = randomUUID();
  const breakdownPdfId = randomUUID();
  const breakdownCsvId = randomUUID();
  const prior = latest.publicSnapshot as unknown as BillingCycleDetailV2;
  const documents: BillingCycleDocument[] = prior.documents.map((document) => ({
    ...document,
    document_id: document.kind === 'monthly_invoice' ? invoiceDocumentId :
      document.format === 'pdf' ? breakdownPdfId : breakdownCsvId,
    issued_at: document.kind === 'monthly_invoice' ? document.issued_at :
      voidedAt.toISOString(),
    download_action: null,
  }));
  const next: BillingCycleDetailV2 = { ...prior, cycle_id: id, state: 'voided',
    totals: prior.totals.map((total) => ({ ...total,
      subscription: cycleMoney(0n, total.currency),
      usage_charge: cycleMoney(0n, total.currency),
      credits_applied: cycleMoney(0n, total.currency),
      total_due: cycleMoney(0n, total.currency),
      total_paid: cycleMoney(0n, total.currency),
      outstanding: cycleMoney(0n, total.currency),
    })), documents };
  const nextEvidence = { ...evidence, previous_cycle_id: latest.id,
    voided_invoice: voidFacts };
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
    const [current, currentInvoice] = await Promise.all([
      tx.billingCustomerCycle.findFirst({ where: { orgId: latest.orgId,
        serviceId: latest.serviceId, teamId: latest.teamId,
        billingMonth: latest.billingMonth }, orderBy: { revision: 'desc' } }),
      tx.billingInvoice.findUnique({ where: { id: invoice.id },
        include: { lines: true, paymentEvents: true,
          _count: { select: { creditSettlementRefs: true } } } }),
    ]);
    if (current?.id !== latest.id || !currentInvoice ||
      currentInvoice.status !== BillingInvoiceStatus.VOID ||
      currentInvoice.voidedAt?.toISOString() !== voidedAt.toISOString() ||
      currentInvoice.paymentEvents.length !== 0 ||
      currentInvoice._count.creditSettlementRefs !== 0 ||
      invoiceSourceFingerprint(currentInvoice) !== invoiceSourceFingerprint(invoice)) {
      hold('BILLING_CYCLE_VOID_SOURCE_CHANGED');
    }
    await tx.billingCustomerCycle.create({ data: {
      id, serviceId: latest.serviceId, orgId: latest.orgId, teamId: latest.teamId,
      billingMonth: latest.billingMonth, revision: latest.revision + 1,
      state: 'voided', payerScope: latest.payerScope,
      publicSnapshot: next as unknown as Prisma.InputJsonValue,
      privateEvidence: nextEvidence as Prisma.InputJsonValue, snapshotSha256,
    } });
    await tx.billingCustomerCycleDocument.createMany({ data: [
      { id: invoiceDocumentId, cycleId: id, kind: 'monthly_invoice', format: 'pdf',
        sourceKind: 'manual_invoice', sourceId: invoice.id,
        invoiceNumber: original.invoiceNumber, issuedAt: original.issuedAt,
        amountMinor: original.amountMinor, currency: original.currency,
        objectKey: original.objectKey, sha256: original.sha256 },
      { id: breakdownPdfId, cycleId: id, kind: 'usage_breakdown', format: 'pdf',
        sourceKind: 'cycle', sourceId: id, issuedAt: invoice.voidedAt,
        objectKey: `${prefix}/usage.pdf`, sha256: pdfSha },
      { id: breakdownCsvId, cycleId: id, kind: 'usage_breakdown', format: 'csv',
        sourceKind: 'cycle', sourceId: id, issuedAt: invoice.voidedAt,
        objectKey: `${prefix}/usage.csv`, sha256: csvSha },
    ] });
    return { cycleId: id, snapshotSha256 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
