import { createHash, randomUUID } from 'node:crypto';

import { BillingInvoiceStatus, Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { lockBillingAdminEffectAuthority,
  type BillingAdminEffectActor } from './billing-admin-effect-authority.service.js';
import { verifiedManualInvoiceLine } from './billing-cycle-manual-allocation.service.js';
import { invoiceSourceFingerprint } from './billing-cycle-manual-invoice.service.js';
import { billingCycleSnapshotDigest } from './billing-cycle-read.service.js';
import { assertInvoiceTaxTerms } from './billing-invoice-tax.service.js';

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

/** Cancellation is a fresh issuer financial decision. It never changes the
 * signed provider receipt, original accepted cash, or the original PDF. */
export async function prepareManualInvoiceCreditNote(params: {
  invoiceId: string; reason: string; actor: BillingAdminEffectActor;
}, deps?: { prisma?: PrismaClient }): Promise<{ id: string; status: string }> {
  const reason = params.reason.trim();
  if (!reason || reason.length > 500) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_NOTE_REASON_INVALID');
  }
  const prisma = deps?.prisma ?? getAdminPrisma();
  return prisma.$transaction(async (tx) => {
    await lockBillingAdminEffectAuthority(tx, params.actor);
    const invoice = await tx.billingInvoice.findUnique({ where: { id: params.invoiceId },
      include: { lines: true, paymentEvents: true, lineFinancialAllocations: true,
        creditSettlementRefs: true, lineCreditAllocations: true } });
    if (!invoice) hold('BILLING_CREDIT_NOTE_INVOICE_MISSING');
    await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations
      WHERE id = ${invoice.orgId} FOR UPDATE`);
    const existing = await tx.billingManualCreditNote.findUnique({ where: {
      originalInvoiceId: invoice.id,
    } });
    if (existing) {
      if (existing.reason !== reason) hold('BILLING_CREDIT_NOTE_REPLAY_CONFLICT');
      return { id: existing.id, status: existing.status };
    }
    if (invoice.status !== BillingInvoiceStatus.ISSUED || invoice.voidedAt ||
      invoice.isCycleSupplement || !invoice.invoiceNumber || !invoice.pdfSha256 ||
      invoice.creditsAppliedMinor !== 0n || invoice.creditSettlementRefs.length !== 0 ||
      invoice.lines.length !== 1) hold('BILLING_CREDIT_NOTE_SOURCE_UNPROVEN');
    const line = invoice.lines[0] ?? hold('BILLING_CREDIT_NOTE_SOURCE_UNPROVEN');
    const allocation = verifiedManualInvoiceLine(invoice, line.serviceId, invoice.billingMonth);
    if (!allocation.soleProduct || allocation.allocation.invoiceCreditMinor !== 0n ||
      allocation.allocation.totalMinor !== invoice.totalMinor ||
      allocation.allocation.subscriptionMinor + allocation.allocation.usageMinor !==
        invoice.subtotalMinor || allocation.allocation.taxMinor !== invoice.taxAmountMinor ||
      invoice.subtotalMinor <= 0n || invoice.totalMinor <= 0n ||
      !invoice.taxTreatment || invoice.taxRateBps === null || !invoice.taxLegalBasis) {
      hold('BILLING_CREDIT_NOTE_SOURCE_UNPROVEN');
    }
    const taxTerms = assertInvoiceTaxTerms({ treatment: invoice.taxTreatment as
      'NO_TAX_CHARGED' | 'STANDARD_RATE', rateBps: invoice.taxRateBps,
    legalBasis: invoice.taxLegalBasis });
    const expectedTax = (invoice.subtotalMinor * BigInt(taxTerms.rateBps) + 5000n) / 10000n;
    if (expectedTax !== invoice.taxAmountMinor) hold('BILLING_CREDIT_NOTE_TAX_UNPROVEN');
    let paid = 0n;
    let refunded = 0n;
    for (const event of invoice.paymentEvents) {
      if (event.currency !== invoice.currency || event.amountMinor < 0n) {
        hold('BILLING_CREDIT_NOTE_PAYMENT_UNPROVEN');
      }
      if (event.kind === 'PAYMENT') paid += event.amountMinor;
      else if (event.kind === 'REFUND') refunded += event.amountMinor;
      else hold('BILLING_CREDIT_NOTE_PAYMENT_UNPROVEN');
    }
    if (paid === 0n || paid > invoice.totalMinor || refunded > paid) {
      hold('BILLING_CREDIT_NOTE_PAYMENT_UNPROVEN');
    }
    const allocations = await tx.billingCustomerCycleInvoiceAllocation.findMany({ where: {
      sourceKind: 'manual', sourceInvoiceId: invoice.id,
    }, include: { cycle: true } });
    if (allocations.length !== 1 || allocations[0]?.sourceLineId !== line.id ||
      allocations[0]?.amountMinor !== invoice.totalMinor) {
      hold('BILLING_CREDIT_NOTE_CYCLE_UNPROVEN');
    }
    const allocatedCycle = allocations[0].cycle;
    const latest = await tx.billingCustomerCycle.findFirst({ where: {
      serviceId: line.serviceId, orgId: invoice.orgId,
      teamId: null, billingMonth: invoice.billingMonth,
    }, orderBy: { revision: 'desc' } });
    if (!latest || latest.state !== 'finalized' ||
      allocatedCycle.teamId !== null || latest.teamId !== null ||
      allocatedCycle.orgId !== invoice.orgId || latest.orgId !== invoice.orgId ||
      allocatedCycle.serviceId !== line.serviceId || latest.serviceId !== line.serviceId ||
      billingCycleSnapshotDigest(latest.publicSnapshot, latest.privateEvidence) !==
        latest.snapshotSha256 ||
      (latest.privateEvidence as Record<string, unknown>).invoice_source_fingerprint !==
        invoiceSourceFingerprint(invoice)) hold('BILLING_CREDIT_NOTE_CYCLE_UNPROVEN');
    const sourceDigest = invoiceSourceFingerprint(invoice);
    const id = randomUUID();
    const evidenceDigest = createHash('sha256').update(JSON.stringify({
      original_invoice_id: invoice.id, original_cycle_id: latest.id,
      source_digest: sourceDigest, reason, actor_user_id: params.actor.userId,
      net_minor: invoice.subtotalMinor.toString(), tax_minor: invoice.taxAmountMinor.toString(),
    })).digest('hex');
    await tx.billingManualCreditNote.create({ data: {
      id, originalInvoiceId: invoice.id, originalCycleId: latest.id,
      issuerProfileId: invoice.issuerProfileId, orgId: invoice.orgId,
      serviceId: line.serviceId, billingMonth: invoice.billingMonth,
      currency: invoice.currency, netCreditMinor: invoice.subtotalMinor,
      taxCreditMinor: invoice.taxAmountMinor, totalCreditMinor: invoice.totalMinor,
      taxTreatment: taxTerms.treatment, taxRateBps: taxTerms.rateBps,
      taxLegalBasis: taxTerms.legalBasis,
      issuerSnapshot: invoice.issuerSnapshot as Prisma.InputJsonValue,
      buyerSnapshot: invoice.buyerSnapshot as Prisma.InputJsonValue,
      originalSourceDigest: sourceDigest, reason, evidenceDigest,
      createdByUserId: params.actor.userId ?? null,
      createdByEmail: params.actor.email,
    } });
    await tx.adminAuditLog.create({ data: { actorEmail: params.actor.email,
      action: 'billing.manual_credit_note_prepared',
      metadata: { credit_note_id: id, original_invoice_id: invoice.id,
        original_cycle_id: latest.id, reason } } });
    return { id, status: 'PENDING' };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
