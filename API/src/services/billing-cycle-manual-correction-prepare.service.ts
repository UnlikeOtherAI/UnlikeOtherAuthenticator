import { createHash, randomUUID } from 'node:crypto';

import {
  BillingAssignmentScope, BillingInvoiceStatus, BillingUsagePaymentMode, Prisma,
  type PrismaClient,
} from '@prisma/client';

import type { BillingCycleDetailV2 } from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { lockBillingAdminEffectAuthority,
  type BillingAdminEffectActor } from './billing-admin-effect-authority.service.js';
import { readVerifiedCycleCreditEvidence } from './billing-cycle-paid-credit-evidence.service.js';
import { billingCycleSnapshotDigest } from './billing-cycle-read.service.js';
import { invoiceSourceFingerprint } from './billing-cycle-manual-invoice.service.js';
import { readCycleWalletBoundary } from './billing-cycle-wallet-boundary.service.js';
import { verifiedManualInvoiceLine } from './billing-cycle-manual-allocation.service.js';
import { assertInvoiceTaxTerms } from './billing-invoice-tax.service.js';
import { addBillingDecimals, majorAmountToMinorRounded } from './billing-money.service.js';
import type { CycleUsageEvidence } from './billing-cycle-usage-projection.service.js';
import type { LedgerPaidReceiptSet, PaidReceiptScope } from
  './billing-ledger-paid-receipt-proof.service.js';

type Evidence = Record<string, unknown> & {
  ledger_snapshots?: CycleUsageEvidence[];
  paid_receipt_proofs?: LedgerPaidReceiptSet[];
};

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function usageMinor(detail: BillingCycleDetailV2, currency: string): bigint {
  let amount = '0';
  for (const line of detail.usage_lines) {
    if (line.usage_payment_mode !== 'pay_as_you_go' ||
      !line.customer_charge || line.customer_charge.currency !== currency) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_USAGE_INVALID');
    }
    amount = addBillingDecimals(amount, line.customer_charge.amount);
  }
  return majorAmountToMinorRounded(amount, currency);
}

function monthBounds(month: string) {
  const startsAt = new Date(`${month}-01T00:00:00.000Z`);
  return { startsAt, endsAt: new Date(Date.UTC(startsAt.getUTCFullYear(),
    startsAt.getUTCMonth() + 1, 1)) };
}

export async function verifyPendingManualCorrectionReceipts(
  reader: PrismaClient | Prisma.TransactionClient,
  pending: { serviceId: string; orgId: string; teamId: string | null;
    billingMonth: string; payerScope: BillingAssignmentScope },
  snapshot: BillingCycleDetailV2, evidence: Evidence, tariffId: string,
): Promise<void> {
  const tariff = await reader.billingTariff.findUnique({ where: { id: tariffId } });
  const snapshots = evidence.ledger_snapshots;
  const proofs = evidence.paid_receipt_proofs;
  const captured = evidence.credit_evidence as Array<{ fingerprint?: string }> | undefined;
  if (!tariff || tariff.usagePaymentMode !== BillingUsagePaymentMode.PAY_AS_YOU_GO ||
    !snapshots || !proofs || !captured ||
    snapshots.length !== proofs.length || snapshots.length !== captured.length) {
    hold('BILLING_CYCLE_MANUAL_CORRECTION_RECEIPTS_UNPROVEN');
  }
  for (let index = 0; index < snapshots.length; index += 1) {
    const metering = snapshots[index];
    const proof = proofs[index];
    const expected = captured[index];
    if (!metering || !proof || !expected ||
      metering.team_id !== proof.scope.team_id ||
      (pending.teamId !== null && metering.team_id !== pending.teamId)) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_RECEIPTS_UNPROVEN');
    }
    const scope: PaidReceiptScope = { product: snapshot.product.identifier,
      organisationId: pending.orgId, teamId: metering.team_id,
      billingMonth: pending.billingMonth, serviceId: pending.serviceId };
    const verified = await readVerifiedCycleCreditEvidence(reader, { scope, proof,
      payer: pending.payerScope, tariff, rawLines: metering.raw_lines });
    if (verified.fingerprint !== expected.fingerprint) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_RECEIPTS_CHANGED');
    }
  }
  const bounds = monthBounds(pending.billingMonth);
  const wallet = await readCycleWalletBoundary(reader, { orgId: pending.orgId,
    teamId: pending.teamId, payer: pending.payerScope, ...bounds });
  if (wallet.fingerprint !== (evidence.wallet_boundary as
    { fingerprint?: string } | undefined)?.fingerprint) {
    hold('BILLING_CYCLE_MANUAL_CORRECTION_WALLET_CHANGED');
  }
}

/** Freezes a delta-only draft. Issuance remains the normal legal invoice flow;
 * a separate finalizer will bind the actual issued PDF and allocated line. */
export async function prepareManualBillingCycleCorrection(params: {
  pendingCycleId: string; actor: BillingAdminEffectActor;
}, deps?: { prisma?: PrismaClient }): Promise<{ invoiceId: string; correctionId: string }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  return prisma.$transaction(async (tx) => {
    await lockBillingAdminEffectAuthority(tx, params.actor);
    const pending = await tx.billingCustomerCycle.findUnique({ where: {
      id: params.pendingCycleId,
    } });
    if (!pending || pending.state !== 'pending_reconciliation') {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_PENDING_MISSING');
    }
    await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations
      WHERE id = ${pending.orgId} FOR UPDATE`);
    const latest = await tx.billingCustomerCycle.findFirst({ where: {
      serviceId: pending.serviceId, orgId: pending.orgId,
      teamId: pending.teamId, billingMonth: pending.billingMonth,
    }, orderBy: { revision: 'desc' } });
    if (latest?.id !== pending.id ||
      billingCycleSnapshotDigest(pending.publicSnapshot, pending.privateEvidence) !==
        pending.snapshotSha256) hold('BILLING_CYCLE_MANUAL_CORRECTION_PENDING_CHANGED');
    const current = pending.publicSnapshot as unknown as BillingCycleDetailV2;
    const evidence = pending.privateEvidence as Evidence;
    const originalId = current.correction_of_cycle_id;
    const previous = originalId ? await tx.billingCustomerCycle.findUnique({ where: {
      id: originalId,
    } }) : null;
    if (!previous || (previous.state !== 'finalized' && previous.state !== 'adjusted') ||
      previous.serviceId !== pending.serviceId || previous.orgId !== pending.orgId ||
      previous.teamId !== pending.teamId || previous.billingMonth !== pending.billingMonth ||
      previous.payerScope !== pending.payerScope ||
      billingCycleSnapshotDigest(previous.publicSnapshot, previous.privateEvidence) !==
        previous.snapshotSha256) hold('BILLING_CYCLE_MANUAL_CORRECTION_ORIGINAL_INVALID');
    const prior = previous.publicSnapshot as unknown as BillingCycleDetailV2;
    const priorEvidence = previous.privateEvidence as Evidence;
    const quote = evidence.quote as Record<string, unknown> | undefined;
    const priorQuote = priorEvidence.quote as Record<string, unknown> | undefined;
    const source = quote?.source as { kind?: string; id?: string } | undefined;
    const allocation = (priorEvidence.primary_invoice_allocation ??
      priorEvidence.invoice_allocation) as
      { source_kind?: string; source_invoice_id?: string; source_line_id?: string } | undefined;
    if (source?.kind !== 'manual' || typeof source.id !== 'string' ||
      !quote || quote.tariff_id !== priorQuote?.tariff_id ||
      evidence.quote_fingerprint !== priorEvidence.quote_fingerprint ||
      JSON.stringify(current.subscription_lines) !== JSON.stringify(prior.subscription_lines) ||
      allocation?.source_kind !== 'manual' || !allocation.source_invoice_id ||
      !allocation.source_line_id || pending.teamId !== null) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_SOURCE_INVALID');
    }
    await verifyPendingManualCorrectionReceipts(tx, pending, current, evidence,
      String(quote.tariff_id));
    const fundedTotal = (source: Evidence): bigint | null => {
      const rows = source.credit_evidence as Array<{
        funded_debit_microcredits?: string | null }> | undefined;
      if (!rows || rows.some((row) => row.funded_debit_microcredits === null ||
        row.funded_debit_microcredits === undefined)) return null;
      return rows.reduce((sum, row) => sum + BigInt(row.funded_debit_microcredits ?? '0'), 0n);
    };
    const currentFunded = fundedTotal(evidence);
    const priorFunded = fundedTotal(priorEvidence);
    const payerAccount = currentFunded === null || priorFunded === null ?
      await tx.billingCreditAccount.findFirst({ where: { orgId: pending.orgId,
        teamId: pending.payerScope === BillingAssignmentScope.TEAM ? pending.teamId : null,
        scope: pending.payerScope, currency: 'USD' }, select: { id: true } }) : null;
    // An account without a settled offset can acquire one later. The only
    // provable zero is an account that did not exist at this frozen close.
    if (currentFunded !== priorFunded ||
      (currentFunded === null && payerAccount)) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_FUNDED_OFFSET_REQUIRED');
    }
    const invoice = await tx.billingInvoice.findUnique({ where: {
      id: allocation.source_invoice_id,
    }, include: { lines: true, paymentEvents: true, lineFinancialAllocations: true,
      creditSettlementRefs: true, lineCreditAllocations: true } });
    if (!invoice || invoice.status !== BillingInvoiceStatus.ISSUED || invoice.voidedAt ||
      invoiceSourceFingerprint(invoice) !== priorEvidence.invoice_source_fingerprint) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_ORIGINAL_INVOICE_CHANGED');
    }
    const bound = verifiedManualInvoiceLine(invoice, pending.serviceId, pending.billingMonth);
    if (bound.line.id !== allocation.source_line_id ||
      invoice.currency !== quote.currency || !invoice.taxTreatment ||
      invoice.taxRateBps === null || !invoice.taxLegalBasis) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_TAX_POLICY_UNPROVEN');
    }
    const taxTerms = assertInvoiceTaxTerms({ treatment: invoice.taxTreatment as
      'NO_TAX_CHARGED' | 'STANDARD_RATE', rateBps: invoice.taxRateBps,
    legalBasis: invoice.taxLegalBasis });
    const originalTax = (invoice.subtotalMinor * BigInt(taxTerms.rateBps) + 5000n) / 10000n;
    if (invoice.taxAmountMinor !== originalTax) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_TAX_POLICY_UNPROVEN');
    }
    const oldUsage = usageMinor(prior, invoice.currency);
    const newUsage = usageMinor(current, invoice.currency);
    const netDelta = newUsage - oldUsage;
    if (netDelta <= 0n) hold(netDelta === 0n ?
      'BILLING_CYCLE_MANUAL_CORRECTION_NO_CHARGE' :
      'BILLING_CYCLE_MANUAL_CREDIT_NOTE_REQUIRED');
    const existing = await tx.billingCycleManualCorrection.findUnique({ where: {
      pendingCycleId: pending.id,
    } });
    if (existing) return { invoiceId: existing.supplementInvoiceId ?? hold(
      'BILLING_CYCLE_MANUAL_CORRECTION_INVOICE_MISSING'), correctionId: existing.id };
    const previousCorrections = await tx.billingCycleManualCorrection.findMany({ where: {
      originalLineId: bound.line.id,
    }, include: { supplementInvoice: true } });
    if (previousCorrections.some((row) => row.kind !== 'debit' ||
      row.supplementInvoice?.status !== BillingInvoiceStatus.ISSUED)) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_PREVIOUS_UNRESOLVED');
    }
    const priorCorrectionNet = previousCorrections.reduce((sum, row) =>
      sum + row.netDeltaMinor, 0n);
    const priorCorrectionTax = previousCorrections.reduce((sum, row) =>
      sum + row.taxDeltaMinor, 0n);
    if (bound.allocation.usageMinor + priorCorrectionNet !== oldUsage) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_HISTORY_MISMATCH');
    }
    const taxableBefore = invoice.subtotalMinor + priorCorrectionNet;
    const taxBefore = invoice.taxAmountMinor + priorCorrectionTax;
    const taxAfter = ((taxableBefore + netDelta) * BigInt(taxTerms.rateBps) + 5000n) / 10000n;
    const taxDelta = taxAfter - taxBefore;
    if (taxDelta < 0n || netDelta + taxDelta > 9_223_372_036_854_775_807n) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_TAX_INVALID');
    }
    const sourceDigest = invoiceSourceFingerprint(invoice);
    const meteringReference = evidence.ledger_snapshots?.[0];
    if (!meteringReference || !meteringReference.cursor ||
      !/^[a-f0-9]{64}$/i.test(meteringReference.sha256) ||
      !Number.isFinite(Date.parse(meteringReference.captured_at))) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_METERING_REFERENCE_MISSING');
    }
    const evidenceDigest = hash({ pending_id: pending.id, pending_sha: pending.snapshotSha256,
      original_id: previous.id, original_sha: previous.snapshotSha256,
      original_invoice_id: invoice.id, original_digest: sourceDigest,
      original_line_id: bound.line.id, net_delta: netDelta.toString(),
      tax_delta: taxDelta.toString(), tax_terms: taxTerms });
    const term = await tx.billingContractServiceTerm.findUnique({ where: { id: source.id },
      select: { serviceId: true, contractVersionId: true } });
    if (term?.serviceId !== pending.serviceId ||
      term.contractVersionId !== invoice.contractVersionId) {
      hold('BILLING_CYCLE_MANUAL_CORRECTION_TERM_MISMATCH');
    }
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(
      hashtextextended(${`uoa-invoice-revision:${invoice.contractId}:${invoice.billingMonth}`}, 0))::text`);
    const latestInvoice = await tx.billingInvoice.findFirst({ where: {
      contractId: invoice.contractId, billingMonth: invoice.billingMonth,
    }, orderBy: { revision: 'desc' }, select: { revision: true } });
    const supplementId = randomUUID();
    const lineId = randomUUID();
    const correctionId = randomUUID();
    await tx.billingInvoice.create({ data: {
      id: supplementId, orgId: invoice.orgId, contractId: invoice.contractId,
      isCycleSupplement: true,
      contractVersionId: invoice.contractVersionId,
      issuerProfileId: invoice.issuerProfileId, buyerProfileId: invoice.buyerProfileId,
      billingMonth: invoice.billingMonth, revision: (latestInvoice?.revision ?? 0) + 1,
      currency: invoice.currency, subtotalMinor: netDelta,
      taxAmountMinor: taxDelta, totalMinor: netDelta + taxDelta,
      creditsAppliedMinor: 0n, taxTreatment: taxTerms.treatment,
      taxRateBps: taxTerms.rateBps, taxLegalBasis: taxTerms.legalBasis,
      issuerSnapshot: invoice.issuerSnapshot as Prisma.InputJsonValue,
      buyerSnapshot: invoice.buyerSnapshot as Prisma.InputJsonValue,
      calculationDigest: evidenceDigest,
      createdByUserId: params.actor.userId ?? null,
      createdByEmail: params.actor.email,
      lines: { create: { id: lineId, serviceId: pending.serviceId,
        serviceIdentifier: bound.line.serviceIdentifier,
        serviceName: bound.line.serviceName,
        amountMinor: netDelta, currency: invoice.currency, position: 1 } },
      meteringRefs: { create: { serviceId: pending.serviceId,
        ledgerSnapshotCursor: meteringReference.cursor,
        ledgerSnapshotSha256: meteringReference.sha256,
        capturedAt: new Date(meteringReference.captured_at) } },
    } });
    await tx.billingInvoiceLineFinancialAllocation.create({ data: {
      lineId, invoiceId: supplementId, serviceId: pending.serviceId,
      billingMonth: pending.billingMonth, subscriptionMinor: 0n,
      usageMinor: netDelta, taxMinor: taxDelta, invoiceCreditMinor: 0n,
      totalMinor: netDelta + taxDelta, dueMinor: netDelta + taxDelta,
      currency: invoice.currency, calculationDigest: evidenceDigest,
    } });
    await tx.billingCycleManualCorrection.create({ data: {
      id: correctionId, pendingCycleId: pending.id, originalCycleId: previous.id,
      supplementInvoiceId: supplementId, kind: 'debit',
      netDeltaMinor: netDelta, taxDeltaMinor: taxDelta,
      currency: invoice.currency, originalLineId: bound.line.id,
      originalSourceDigest: sourceDigest, taxTreatment: taxTerms.treatment,
      taxRateBps: taxTerms.rateBps, taxLegalBasis: taxTerms.legalBasis,
      evidenceDigest, createdByUserId: params.actor.userId ?? null,
      createdByEmail: params.actor.email,
    } });
    await tx.adminAuditLog.create({ data: { actorEmail: params.actor.email,
      action: 'billing.cycle_manual_correction_prepared',
      metadata: { correction_id: correctionId, supplement_invoice_id: supplementId,
        pending_cycle_id: pending.id, original_cycle_id: previous.id } } });
    return { invoiceId: supplementId, correctionId };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/** Operator doorway for closed-cycle exceptions; the issue action still
 * requires a fresh superuser financial authority and full evidence recheck. */
export async function listPendingManualBillingCycleCorrections(
  deps?: { prisma?: PrismaClient },
): Promise<Array<{ cycleId: string; orgId: string; serviceId: string;
  billingMonth: string; direction: 'debit' | 'credit' | 'unknown';
  supplementInvoiceId: string | null }>> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const cycles = await prisma.billingCustomerCycle.findMany({ where: {
    state: 'pending_reconciliation', teamId: null,
  }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
  include: { manualCorrection: true } });
  const result: Array<{ cycleId: string; orgId: string; serviceId: string;
    billingMonth: string; direction: 'debit' | 'credit' | 'unknown';
    supplementInvoiceId: string | null }> = [];
  for (const cycle of cycles) {
    const evidence = cycle.privateEvidence as Evidence;
    const quote = evidence.quote as Record<string, unknown> | undefined;
    const source = quote?.source as { kind?: string } | undefined;
    const current = cycle.publicSnapshot as unknown as BillingCycleDetailV2;
    if (source?.kind !== 'manual' || !current.correction_of_cycle_id) continue;
    const previous = await prisma.billingCustomerCycle.findUnique({ where: {
      id: current.correction_of_cycle_id,
    } });
    let direction: 'debit' | 'credit' | 'unknown' = 'unknown';
    if (previous && typeof quote?.currency === 'string') {
      try {
        const before = usageMinor(previous.publicSnapshot as unknown as BillingCycleDetailV2,
          quote.currency);
        const after = usageMinor(current, quote.currency);
        direction = after > before ? 'debit' : after < before ? 'credit' : 'unknown';
      } catch {
        // The preparation action reports the exact missing proof.
      }
    }
    result.push({ cycleId: cycle.id, orgId: cycle.orgId,
      serviceId: cycle.serviceId, billingMonth: cycle.billingMonth,
      direction, supplementInvoiceId: cycle.manualCorrection?.supplementInvoiceId ?? null });
  }
  return result;
}
