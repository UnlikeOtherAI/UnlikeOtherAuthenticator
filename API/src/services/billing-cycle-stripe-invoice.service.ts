import { createHash, randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import type { BillingCycleDetailV2, BillingCycleDocument } from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { renderBillingCycleBreakdownCsv, renderBillingCycleBreakdownPdf }
  from './billing-cycle-breakdown.service.js';
import { financialCycleEvidence, verifyFinancialCycleProof }
  from './billing-cycle-financial-proof.service.js';
import { billingCycleSnapshotDigest } from './billing-cycle-read.service.js';
import { readStripeCycleFinancialSources, stripeCycleAllocationKey }
  from './billing-cycle-stripe-allocation.service.js';
import { cycleMoney } from './billing-cycle-quote-projection.service.js';
import { usdFromRatedMicrocredits } from './billing-cycle-paid-credit-evidence.service.js';
import { majorAmountToMinorRounded } from './billing-money.service.js';
import { copyVerifiedDocument } from './billing-cycle-manual-invoice.service.js';
import { createBillingInvoicePdfStorage, type BillingInvoicePdfStorage }
  from './billing-invoice-storage.service.js';

function hold(code: string): never { throw new AppError('INTERNAL', 409, code); }
function document(kind: BillingCycleDocument['kind'], format: 'pdf' | 'csv',
  number: string | null, issuedAt: Date, amount: bigint | null, currency: string): BillingCycleDocument {
  return { document_id: randomUUID(), kind, format, state: 'available', number,
    issued_at: issuedAt.toISOString(), customer_total: amount === null ? null :
      cycleMoney(amount, currency), download_action: null };
}

/** Actual service lines may span several cash invoices, and each legal line is
 * allocated once. A changed receipt stays pending until its actual delta is invoiced. */
export async function captureIssuedStripeBillingCycle(params: { cycleId: string },
  deps?: { prisma?: PrismaClient; storage?: BillingInvoicePdfStorage }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const storage = deps?.storage ?? createBillingInvoicePdfStorage();
  const cycle = await prisma.billingCustomerCycle.findUniqueOrThrow({
    where: { id: params.cycleId } });
  const evidence = financialCycleEvidence(cycle);
  const pending = cycle.publicSnapshot as unknown as BillingCycleDetailV2;
  if (evidence.quote.source.kind !== 'stripe') return null;
  const scope = { subscriptionId: evidence.quote.source.id, serviceId: cycle.serviceId,
    orgId: cycle.orgId, teamId: cycle.teamId, billingMonth: cycle.billingMonth,
    currency: evidence.quote.currency };
  const captured = await readStripeCycleFinancialSources(prisma, scope);
  if (cycle.state === 'finalized' || cycle.state === 'adjusted') {
    if (evidence.stripe_financial_fingerprint === captured.fingerprint) {
      return { cycleId: cycle.id, snapshotSha256: cycle.snapshotSha256 };
    }
  } else if (cycle.state !== 'pending_reconciliation') return null;
  if (captured.sources.length === 0) return null;
  const currency = scope.currency;
  let collectible = 0n;
  let funded = 0n;
  const tariff = await prisma.billingTariff.findUniqueOrThrow({
    where: { id: evidence.quote.tariff_id } });
  if (currency !== 'USD') hold('BILLING_CYCLE_STRIPE_FX_UNPROVEN');
  if (tariff.usagePaymentMode === 'PAY_AS_YOU_GO') {
    for (const row of evidence.credit_evidence) {
      const amount = BigInt(row.consumed_microcredits) - BigInt(row.waived_microcredits);
      const offset = row.funded_debit_microcredits === null ? 0n :
        BigInt(row.funded_debit_microcredits);
      if (amount < 0n || offset < 0n || offset > amount) hold('BILLING_CYCLE_STRIPE_CREDIT_UNPROVEN');
      collectible += amount;
      funded += offset;
    }
  } else if (pending.usage_lines.some((line) => line.customer_charge !== null)) {
    hold('BILLING_CYCLE_STRIPE_PREPAID_CHARGE_CONFLICT');
  }
  const grossUsage = majorAmountToMinorRounded(usdFromRatedMicrocredits(collectible), currency);
  const netUsage = majorAmountToMinorRounded(usdFromRatedMicrocredits(collectible - funded), currency);
  const subscription = BigInt(evidence.quote.amount_minor);
  if (captured.subscription !== subscription || captured.usage !== netUsage ||
    pending.subscription_lines.length !== 1 ||
    pending.subscription_lines[0]?.customer_charge.amount_minor !== subscription.toString()) {
    hold('BILLING_CYCLE_STRIPE_ACTUAL_AMOUNT_MISMATCH');
  }
  const prior = pending.correction_of_cycle_id ?
    await prisma.billingCustomerCycle.findUnique({ where: { id: pending.correction_of_cycle_id } }) :
    cycle.state === 'finalized' || cycle.state === 'adjusted' ? cycle : null;
  if (prior && (prior.orgId !== cycle.orgId || prior.teamId !== cycle.teamId ||
    prior.serviceId !== cycle.serviceId || prior.billingMonth !== cycle.billingMonth ||
    billingCycleSnapshotDigest(prior.publicSnapshot, prior.privateEvidence) !== prior.snapshotSha256)) {
    hold('BILLING_CYCLE_STRIPE_ORIGINAL_BINDING');
  }
  const originalAllocations = await prisma.billingCustomerCycleInvoiceAllocation.findMany({
    where: { cycle: { serviceId: cycle.serviceId, orgId: cycle.orgId,
      teamId: cycle.teamId, billingMonth: cycle.billingMonth } } });
  const selectedKeys = new Set(captured.sources.flatMap((source) => source.selected.map((line) =>
    stripeCycleAllocationKey(source.row, line.stripeLineId))));
  if (originalAllocations.some((row) => !selectedKeys.has(row.authorityKey))) {
    hold('BILLING_CYCLE_STRIPE_ORIGINAL_LINE_MISSING');
  }
  const id = randomUUID();
  const issuedAt = new Date(Math.max(...captured.sources.map((source) =>
    source.row.issuedAt?.getTime() ?? hold('BILLING_CYCLE_STRIPE_ISSUED_AT_MISSING'))));
  const legal = captured.sources.filter((source) => source.soleProduct).map((source) => ({
    source, public: document('monthly_invoice', 'pdf', source.row.invoiceNumber,
      source.row.issuedAt ?? issuedAt, source.row.grossAmountMinor, currency),
  }));
  const pdfDocument = document('usage_breakdown', 'pdf', null, issuedAt, null, currency);
  const csvDocument = document('usage_breakdown', 'csv', null, issuedAt, null, currency);
  const state = prior ? 'adjusted' : 'finalized';
  const next: BillingCycleDetailV2 = { ...pending, cycle_id: id, state,
    ...(prior ? { correction_of_cycle_id: prior.id } : {}),
    totals: [{ currency, subscription: cycleMoney(subscription, currency),
      usage_charge: cycleMoney(grossUsage, currency), tax: cycleMoney(captured.tax, currency),
      gross_total: cycleMoney(subscription + grossUsage + captured.tax, currency),
      credits_applied: cycleMoney(grossUsage - netUsage + captured.credits, currency),
      total_due: cycleMoney(captured.due, currency), total_paid: cycleMoney(captured.paid, currency),
      outstanding: cycleMoney(captured.due - captured.paid, currency) }],
    documents: [...legal.map((row) => row.public), pdfDocument, csvDocument], document_available: true };
  const nextEvidence = { ...evidence, previous_cycle_id: cycle.id,
    stripe_financial_fingerprint: captured.fingerprint,
    stripe_invoice_allocations: captured.sources.flatMap((source) => source.selected.map((line) => ({
      authority_key: stripeCycleAllocationKey(source.row, line.stripeLineId),
      source_invoice_id: source.row.id, source_line_id: line.stripeLineId,
      source_digest: source.row.sourceDigest, financial_fingerprint: source.fingerprint,
    }))) };
  const snapshotSha256 = billingCycleSnapshotDigest(next, nextEvidence);
  const verifiedBytes = new Map(await Promise.all(captured.sources.map(async (source) => {
    const key = source.row.pdfObjectKey ?? hold('BILLING_CYCLE_STRIPE_PDF_PENDING');
    const bytes = await storage.read(key);
    if (bytes.subarray(0, 5).toString() !== '%PDF-' ||
      createHash('sha256').update(bytes).digest('hex') !== source.row.pdfSha256) {
      hold('BILLING_CYCLE_STRIPE_PDF_INTEGRITY');
    }
    return [source.row.id, bytes] as const;
  })));
  const legalBytes = legal.map(({ source }) => verifiedBytes.get(source.row.id) ??
    hold('BILLING_CYCLE_STRIPE_PDF_BINDING'));
  const prefix = `billing-cycles/${id}`;
  const legalHashes = await Promise.all(legalBytes.map((bytes, index) =>
    copyVerifiedDocument(storage, `${prefix}/invoice-${index}.pdf`, bytes, 'application/pdf')));
  const [pdfSha, csvSha] = await Promise.all([
    renderBillingCycleBreakdownPdf(next).then((bytes) =>
      copyVerifiedDocument(storage, `${prefix}/usage.pdf`, bytes, 'application/pdf')),
    copyVerifiedDocument(storage, `${prefix}/usage.csv`, renderBillingCycleBreakdownCsv(next), 'text/csv'),
  ]);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations WHERE id = ${cycle.orgId} FOR UPDATE`);
    const latest = await tx.billingCustomerCycle.findFirst({ where: { serviceId: cycle.serviceId,
      orgId: cycle.orgId, teamId: cycle.teamId, billingMonth: cycle.billingMonth },
    orderBy: { revision: 'desc' } });
    if (latest?.id !== cycle.id) {
      const priorEvidence = latest?.privateEvidence as Record<string, unknown> | undefined;
      if (priorEvidence?.previous_cycle_id === cycle.id &&
        priorEvidence?.stripe_financial_fingerprint === captured.fingerprint && latest &&
        billingCycleSnapshotDigest(latest.publicSnapshot, latest.privateEvidence) === latest.snapshotSha256) {
        return { cycleId: latest.id, snapshotSha256: latest.snapshotSha256 };
      }
      hold('BILLING_CYCLE_STRIPE_REVISION_CHANGED');
    }
    await verifyFinancialCycleProof(tx, cycle);
    const current = await readStripeCycleFinancialSources(tx, scope);
    if (current.fingerprint !== captured.fingerprint) hold('BILLING_CYCLE_STRIPE_SOURCE_CHANGED');
    for (const source of captured.sources) {
      for (const line of source.selected) {
        const key = stripeCycleAllocationKey(source.row, line.stripeLineId);
        const existing = await tx.billingCustomerCycleInvoiceAllocation.findUnique({
          where: { authorityKey: key }, include: { cycle: true } });
        if (existing && (existing.cycle.orgId !== cycle.orgId ||
          existing.cycle.teamId !== cycle.teamId || existing.cycle.serviceId !== cycle.serviceId ||
          existing.cycle.billingMonth !== cycle.billingMonth || existing.sourceDigest !== source.row.sourceDigest ||
          existing.amountMinor !== line.grossMinor || existing.currency !== currency)) {
          hold('BILLING_CYCLE_STRIPE_LINE_ALREADY_ALLOCATED');
        }
      }
    }
    await tx.billingCustomerCycle.create({ data: { id, serviceId: cycle.serviceId, orgId: cycle.orgId,
      teamId: cycle.teamId, billingMonth: cycle.billingMonth, revision: cycle.revision + 1,
      state, payerScope: cycle.payerScope, publicSnapshot: next as unknown as Prisma.InputJsonValue,
      privateEvidence: nextEvidence as unknown as Prisma.InputJsonValue, snapshotSha256 } });
    for (const source of captured.sources) {
      for (const line of source.selected) {
        const authorityKey = stripeCycleAllocationKey(source.row, line.stripeLineId);
        await tx.billingCustomerCycleInvoiceAllocation.upsert({ where: { authorityKey }, update: {},
          create: { cycleId: id, authorityKey, sourceKind: 'stripe', sourceAccountId: source.row.accountId,
            sourceInvoiceId: source.row.id, sourceLineId: line.stripeLineId,
            periodStartsAt: new Date(pending.period.starts_at), periodEndsAt: new Date(pending.period.ends_at),
            amountMinor: line.grossMinor, currency, sourceDigest: source.row.sourceDigest } });
      }
    }
    await tx.billingCustomerCycleDocument.createMany({ data: [
      ...legal.map(({ source, public: doc }, index) => ({ id: doc.document_id, cycleId: id,
        kind: 'monthly_invoice', format: 'pdf', sourceKind: 'stripe_invoice', sourceId: source.row.id,
        invoiceNumber: source.row.invoiceNumber, issuedAt: source.row.issuedAt,
        amountMinor: source.row.grossAmountMinor, currency,
        objectKey: `${prefix}/invoice-${index}.pdf`, sha256: legalHashes[index] ??
          hold('BILLING_CYCLE_STRIPE_PDF_BINDING') })),
      { id: pdfDocument.document_id, cycleId: id, kind: 'usage_breakdown', format: 'pdf',
        sourceKind: 'cycle', sourceId: id, issuedAt, objectKey: `${prefix}/usage.pdf`, sha256: pdfSha },
      { id: csvDocument.document_id, cycleId: id, kind: 'usage_breakdown', format: 'csv',
        sourceKind: 'cycle', sourceId: id, issuedAt, objectKey: `${prefix}/usage.csv`, sha256: csvSha },
    ] });
    return { cycleId: id, snapshotSha256 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
