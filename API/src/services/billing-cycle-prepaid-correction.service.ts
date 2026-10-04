import { createHash, randomUUID } from 'node:crypto';

import {
  BillingInvoiceStatus, BillingUsagePaymentMode, Prisma, type PrismaClient,
} from '@prisma/client';

import type {
  BillingCycleDetailV2, BillingCycleDocument,
} from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  renderBillingCycleBreakdownCsv, renderBillingCycleBreakdownPdf,
} from './billing-cycle-breakdown.service.js';
import { readVerifiedCycleCreditEvidence,
  usdFromRatedMicrocredits, type VerifiedCycleCreditEvidence } from
  './billing-cycle-paid-credit-evidence.service.js';
import { billingCycleSnapshotDigest } from './billing-cycle-read.service.js';
import { cycleMoney } from './billing-cycle-quote-projection.service.js';
import { readCycleWalletBoundary } from './billing-cycle-wallet-boundary.service.js';
import { addBillingDecimals, majorAmountToMinorRounded } from './billing-money.service.js';
import { copyVerifiedDocument, invoiceSourceFingerprint } from
  './billing-cycle-manual-invoice.service.js';
import {
  createBillingInvoicePdfStorage, type BillingInvoicePdfStorage,
} from './billing-invoice-storage.service.js';
import type { CycleUsageEvidence } from './billing-cycle-usage-projection.service.js';
import type {
  LedgerPaidReceiptSet, PaidReceiptScope,
} from './billing-ledger-paid-receipt-proof.service.js';
import { compareBillingCycleUtf8 } from './billing-cycle-binary-order.service.js';

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

type Evidence = Record<string, unknown> & {
  credit_evidence?: VerifiedCycleCreditEvidence[];
  ledger_snapshots?: CycleUsageEvidence[];
  paid_receipt_proofs?: LedgerPaidReceiptSet[];
};

function total(values: VerifiedCycleCreditEvidence[], key:
  'consumed_microcredits' | 'funded_debit_microcredits' | 'waived_microcredits'): bigint {
  return values.reduce((sum, value) => {
    const amount = value[key];
    if (amount === null || !/^\d+$/.test(amount)) hold('BILLING_CYCLE_PREPAID_DEBIT_UNPROVEN');
    return sum + BigInt(amount);
  }, 0n);
}

function legalDocument(source: {
  id: string; kind: string; format: string; invoiceNumber: string | null;
  issuedAt: Date | null; amountMinor: bigint | null; currency: string | null;
}): BillingCycleDocument {
  const kind = source.kind as BillingCycleDocument['kind'];
  const format = source.format as BillingCycleDocument['format'];
  return { document_id: randomUUID(), kind, format, state: 'available',
    number: source.invoiceNumber, issued_at: source.issuedAt?.toISOString() ?? null,
    customer_total: source.amountMinor === null || !source.currency ? null :
      cycleMoney(source.amountMinor, source.currency),
    download_action: null };
}

function manualPaymentDigest(invoice: {
  id: string; invoiceNumber: string | null; pdfSha256: string | null;
  paymentEvents: Array<{ id: string; kind: string; amountMinor: bigint;
    currency: string; occurredAt: Date }>;
}, line: { lineId: string; totalMinor: bigint; currency: string }): string {
  const paymentEvents = invoice.paymentEvents.map((row) => ({
    id: row.id, kind: row.kind, amount_minor: row.amountMinor.toString(),
    currency: row.currency, occurred_at: row.occurredAt.toISOString(),
  })).sort((a, b) => compareBillingCycleUtf8(a.id, b.id));
  return createHash('sha256').update(JSON.stringify({
    invoice_id: invoice.id, line_id: line.lineId,
    invoice_number: invoice.invoiceNumber,
    amount_minor: line.totalMinor.toString(), currency: line.currency,
    pdf_sha256: invoice.pdfSha256, payment_events: paymentEvents,
  })).digest('hex');
}

/** A zero-fee wallet-funded month has no new cash invoice to await. */
export async function finalizePrepaidBillingCycle(
  params: { cycleId: string },
  deps?: { prisma?: PrismaClient; storage?: BillingInvoicePdfStorage },
): Promise<{ cycleId: string; snapshotSha256: string } | null> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const storage = deps?.storage ?? createBillingInvoicePdfStorage();
  const pending = await prisma.billingCustomerCycle.findUnique({
    where: { id: params.cycleId },
  });
  if (!pending || pending.state !== 'pending_reconciliation') return null;
  const latestView = await prisma.billingCustomerCycle.findFirst({ where: {
    serviceId: pending.serviceId, orgId: pending.orgId,
    teamId: pending.teamId, billingMonth: pending.billingMonth,
  }, orderBy: { revision: 'desc' } });
  if (latestView?.id !== pending.id) {
    const latestEvidence = latestView?.privateEvidence as Evidence | undefined;
    if (latestEvidence?.previous_cycle_id === pending.id &&
      (latestView?.state === 'adjusted' || latestView?.state === 'finalized') &&
      billingCycleSnapshotDigest(latestView.publicSnapshot, latestView.privateEvidence) ===
        latestView.snapshotSha256) {
      return { cycleId: latestView.id, snapshotSha256: latestView.snapshotSha256 };
    }
    return null;
  }
  const evidence = pending.privateEvidence as Evidence;
  const revised = pending.publicSnapshot as unknown as BillingCycleDetailV2;
  const originalId = revised.correction_of_cycle_id;
  const previous = typeof originalId === 'string' ?
    await prisma.billingCustomerCycle.findUnique({
      where: { id: originalId }, include: { documents: true },
    }) : null;
  if ((originalId && !previous) ||
    (previous && (previous.state !== 'finalized' && previous.state !== 'adjusted')) ||
    (previous && (previous.serviceId !== pending.serviceId ||
      previous.orgId !== pending.orgId || previous.teamId !== pending.teamId ||
      previous.billingMonth !== pending.billingMonth ||
      previous.payerScope !== pending.payerScope ||
      billingCycleSnapshotDigest(previous.publicSnapshot, previous.privateEvidence) !==
        previous.snapshotSha256)) ||
    billingCycleSnapshotDigest(pending.publicSnapshot, pending.privateEvidence) !==
      pending.snapshotSha256) hold('BILLING_CYCLE_CORRECTION_SOURCE_INVALID');
  const priorEvidence = previous?.privateEvidence as Evidence | undefined;
  const prior = previous?.publicSnapshot as BillingCycleDetailV2 | undefined;
  const tariffId = evidence.source === 'team_usage_only' ? evidence.tariff_id :
    (evidence.quote as Record<string, unknown> | undefined)?.tariff_id;
  const tariff = typeof tariffId === 'string' ?
    await prisma.billingTariff.findUnique({ where: { id: tariffId } }) : null;
  const prepaid = tariff?.usagePaymentMode === BillingUsagePaymentMode.PREPAID;
  const fundedPayg = tariff?.usagePaymentMode === BillingUsagePaymentMode.PAY_AS_YOU_GO;
  if (!tariff || (!prepaid && !fundedPayg) ||
    (prior && (priorEvidence?.quote_fingerprint !== evidence.quote_fingerprint ||
      priorEvidence?.tariff_id !== evidence.tariff_id ||
      prior.scope.team_id !== revised.scope.team_id ||
      prior.scope.payer_scope !== revised.scope.payer_scope ||
      JSON.stringify(prior.subscription_lines) !== JSON.stringify(revised.subscription_lines) ||
      prior.usage_lines.some((line) => line.usage_payment_mode !==
        (prepaid ? 'prepaid' : 'pay_as_you_go') ||
        (prepaid ? line.customer_charge !== null : line.customer_charge === null)))) ||
    ((!prior || fundedPayg) && revised.subscription_lines.some((line) =>
      line.customer_charge.amount_minor !== '0')) ||
    revised.usage_lines.some((line) => line.usage_payment_mode !==
      (prepaid ? 'prepaid' : 'pay_as_you_go') ||
      (prepaid ? line.customer_charge !== null : line.customer_charge === null))) return null;
  const oldCredits = priorEvidence?.credit_evidence ?? [];
  const newCredits = evidence.credit_evidence;
  const snapshots = evidence.ledger_snapshots;
  const proofs = evidence.paid_receipt_proofs;
  if (fundedPayg && (newCredits?.some((row) =>
    row.funded_debit_microcredits === null) || oldCredits.some((row) =>
    row.funded_debit_microcredits === null))) return null;
  if (!newCredits || !snapshots || !proofs ||
    newCredits.length !== snapshots.length || newCredits.length !== proofs.length ||
    total(newCredits, 'consumed_microcredits') <
      total(oldCredits, 'consumed_microcredits') ||
    total(newCredits, 'funded_debit_microcredits') -
      total(oldCredits, 'funded_debit_microcredits') !==
      total(newCredits, 'consumed_microcredits') -
      total(oldCredits, 'consumed_microcredits') -
      (total(newCredits, 'waived_microcredits') -
        total(oldCredits, 'waived_microcredits'))) {
    hold('BILLING_CYCLE_PREPAID_DEBIT_UNPROVEN');
  }
  const allocation = priorEvidence?.invoice_allocation as
    { source_kind?: string; source_invoice_id?: string; source_line_id?: string } | undefined;
  if (allocation && allocation.source_kind !== 'manual') return null;
  if (fundedPayg && allocation) return null;
  if (!allocation && prior?.totals.some((row) =>
    prepaid ? row.gross_total.amount_minor !== '0' :
      row.gross_total.amount_minor !== row.credits_applied.amount_minor ||
      row.total_due.amount_minor !== '0' || row.total_paid.amount_minor !== '0')) return null;
  let fundedPaygTotals: BillingCycleDetailV2['totals'] | null = null;
  if (fundedPayg) {
    const payable = revised.usage_lines.map((line) =>
      line.customer_charge?.amount ?? hold('BILLING_CYCLE_FUNDED_PAYG_CHARGE_MISSING'));
    const usageMinor = majorAmountToMinorRounded(payable.reduce(addBillingDecimals, '0'),
      tariff.currency);
    const debitMinor = majorAmountToMinorRounded(usdFromRatedMicrocredits(
      total(newCredits, 'funded_debit_microcredits')), tariff.currency);
    if (usageMinor !== debitMinor) return null;
    fundedPaygTotals = [{ currency: tariff.currency,
      subscription: cycleMoney(0n, tariff.currency),
      usage_charge: cycleMoney(usageMinor, tariff.currency),
      tax: cycleMoney(0n, tariff.currency),
      gross_total: cycleMoney(usageMinor, tariff.currency),
      credits_applied: cycleMoney(debitMinor, tariff.currency),
      total_due: cycleMoney(0n, tariff.currency),
      total_paid: cycleMoney(0n, tariff.currency),
      outstanding: cycleMoney(0n, tariff.currency) }];
  }

  const newId = randomUUID();
  const existingDocuments = (previous?.documents ?? []).filter((row) =>
    row.kind !== 'usage_breakdown');
  const copied = existingDocuments.map((row) => legalDocument(row));
  const usagePdfId = randomUUID();
  const usageCsvId = randomUUID();
  const issuedAt = new Date();
  const documents: BillingCycleDocument[] = [...copied,
    { document_id: usagePdfId, kind: 'usage_breakdown', format: 'pdf',
      state: 'available', number: null, issued_at: issuedAt.toISOString(),
      customer_total: null, download_action: null },
    { document_id: usageCsvId, kind: 'usage_breakdown', format: 'csv',
      state: 'available', number: null, issued_at: issuedAt.toISOString(),
      customer_total: null, download_action: null }];
  const next: BillingCycleDetailV2 = {
    ...revised, cycle_id: newId, state: prior ? 'adjusted' : 'finalized',
    totals: fundedPaygTotals ?? prior?.totals ?? [{ currency: tariff.currency,
      subscription: cycleMoney(0n, tariff.currency),
      usage_charge: cycleMoney(0n, tariff.currency),
      tax: cycleMoney(0n, tariff.currency),
      gross_total: cycleMoney(0n, tariff.currency),
      credits_applied: cycleMoney(0n, tariff.currency),
      total_due: cycleMoney(0n, tariff.currency),
      total_paid: cycleMoney(0n, tariff.currency),
      outstanding: cycleMoney(0n, tariff.currency) }],
    documents, document_available: true,
    adjustments: prior?.adjustments ?? [],
  };
  const nextEvidence = { ...evidence, previous_cycle_id: pending.id,
    ...(previous ? { correction_of_cycle_id: previous.id } : {}),
    ...(allocation ? { invoice_allocation: priorEvidence?.invoice_allocation,
      invoice_source_fingerprint: priorEvidence?.invoice_source_fingerprint } : {}) };
  const snapshotSha256 = billingCycleSnapshotDigest(next, nextEvidence);
  const prefix = `billing-cycles/${newId}`;
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
      WHERE id = ${pending.orgId} FOR UPDATE`);
    if (fundedPayg) {
      // Stripe export and credit settlement take these same payer locks. An
      // already reserved meter charge cannot be disguised as wallet funding.
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "billing_credit_accounts"
        WHERE "org_id" = ${pending.orgId}
          AND ("team_id" = ${pending.teamId} OR "team_id" IS NULL)
        ORDER BY "id" FOR UPDATE`);
      const exported = await tx.billingStripeUsageExport.findFirst({ where: {
        billingMonth: pending.billingMonth,
        subscription: { serviceId: pending.serviceId, orgId: pending.orgId,
          ...(pending.teamId ? { OR: [{ teamId: pending.teamId }, { teamId: null }] } :
            { teamId: null }) },
        cumulativeMeterQuantity: { gt: 0n },
      }, select: { id: true } });
      if (exported) return null;
    }
    const latest = await tx.billingCustomerCycle.findFirst({ where: {
      serviceId: pending.serviceId, orgId: pending.orgId,
      teamId: pending.teamId, billingMonth: pending.billingMonth,
    }, orderBy: { revision: 'desc' } });
    if (latest?.id !== pending.id) hold('BILLING_CYCLE_CORRECTION_REVISION_CHANGED');
    if (allocation?.source_invoice_id) {
      const invoice = await tx.billingInvoice.findUnique({
        where: { id: allocation.source_invoice_id },
        include: { lines: true, paymentEvents: true, lineFinancialAllocations: true,
          creditSettlementRefs: true, lineCreditAllocations: true },
      });
      const bound = invoice?.lineFinancialAllocations.find((row) =>
        row.lineId === allocation.source_line_id);
      const storedAllocation = priorEvidence?.invoice_allocation as
        { latest_source_digest?: string; source_digest?: string } | undefined;
      if (!invoice || !bound || invoice.status !== BillingInvoiceStatus.ISSUED ||
        invoice.voidedAt ||
        manualPaymentDigest(invoice, bound) !==
          (storedAllocation?.latest_source_digest ?? storedAllocation?.source_digest) ||
        invoiceSourceFingerprint(invoice) !== priorEvidence?.invoice_source_fingerprint) {
        hold('BILLING_CYCLE_CORRECTION_INVOICE_CHANGED');
      }
    }
    const startsAt = new Date(`${pending.billingMonth}-01T00:00:00.000Z`);
    const endsAt = new Date(Date.UTC(startsAt.getUTCFullYear(),
      startsAt.getUTCMonth() + 1, 1));
    const wallet = await readCycleWalletBoundary(tx, {
      orgId: pending.orgId, teamId: pending.teamId,
      payer: pending.payerScope, startsAt, endsAt,
    });
    if (wallet.fingerprint !== (evidence.wallet_boundary as
      { fingerprint?: string } | undefined)?.fingerprint) {
      hold('BILLING_CYCLE_CORRECTION_WALLET_CHANGED');
    }
    for (let index = 0; index < newCredits.length; index += 1) {
      const captured = newCredits[index];
      const snapshot = snapshots[index];
      const proof = proofs[index];
      if (!captured || !snapshot || !proof ||
        captured.team_id !== snapshot.team_id ||
        proof.scope.team_id !== snapshot.team_id) {
        hold('BILLING_CYCLE_CORRECTION_RECEIPT_SCOPE_INVALID');
      }
      const scope: PaidReceiptScope = {
        product: revised.product.identifier, organisationId: pending.orgId,
        teamId: snapshot.team_id, billingMonth: pending.billingMonth,
        serviceId: pending.serviceId,
      };
      const fresh = await readVerifiedCycleCreditEvidence(tx, {
        scope, proof, payer: pending.payerScope, tariff, rawLines: snapshot.raw_lines,
      });
      if (fresh.fingerprint !== captured.fingerprint) {
        hold('BILLING_CYCLE_CORRECTION_RECEIPT_CHANGED');
      }
    }
    await tx.billingCustomerCycle.create({ data: {
      id: newId, serviceId: pending.serviceId, orgId: pending.orgId,
      teamId: pending.teamId, billingMonth: pending.billingMonth,
      revision: pending.revision + 1, state: prior ? 'adjusted' : 'finalized',
      payerScope: pending.payerScope,
      publicSnapshot: next as unknown as Prisma.InputJsonValue,
      privateEvidence: nextEvidence as Prisma.InputJsonValue, snapshotSha256,
    } });
    await tx.billingCustomerCycleDocument.createMany({ data: [
      ...existingDocuments.map((row, index) => ({
        id: copied[index]?.document_id ??
          hold('BILLING_CYCLE_CORRECTION_DOCUMENT_BINDING'),
        cycleId: newId, kind: row.kind,
        format: row.format, sourceKind: row.sourceKind, sourceId: row.sourceId,
        invoiceNumber: row.invoiceNumber, issuedAt: row.issuedAt,
        amountMinor: row.amountMinor, currency: row.currency,
        objectKey: row.objectKey, sha256: row.sha256,
      })),
      { id: usagePdfId, cycleId: newId, kind: 'usage_breakdown', format: 'pdf',
        sourceKind: 'cycle', sourceId: newId, issuedAt,
        objectKey: `${prefix}/usage.pdf`, sha256: pdfSha },
      { id: usageCsvId, cycleId: newId, kind: 'usage_breakdown', format: 'csv',
        sourceKind: 'cycle', sourceId: newId, issuedAt,
        objectKey: `${prefix}/usage.csv`, sha256: csvSha },
    ] });
    return { cycleId: newId, snapshotSha256 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
