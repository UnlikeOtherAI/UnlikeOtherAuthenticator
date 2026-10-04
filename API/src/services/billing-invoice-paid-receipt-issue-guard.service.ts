import { BillingInvoiceStatus, Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

/** The payer account is locked by the caller. A stale draft cannot become a
 * legal cash demand after a wallet debit, nor reuse a receipt already issued
 * on another invoice. The exact source-team check never apportions an org
 * invoice by a current roster or by rounded customer amounts. */
export async function assertManualInvoicePaidReceiptIssueReady(
  tx: Prisma.TransactionClient,
  invoiceId: string,
): Promise<void> {
  const invoice = await tx.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId },
    include: { paidReceipts: true, lines: { include: { financialAllocation: true } },
      creditSettlementRefs: { include: { settlement: true } } } });
  if (invoice.lines.some((line) => !line.financialAllocation)) {
    hold('BILLING_INVOICE_LINE_ALLOCATION_MISSING');
  }
  const paidLines = invoice.lines.filter((line) =>
    (line.financialAllocation?.usageMinor ?? 0n) > 0n);
  if (paidLines.some((line) => !invoice.paidReceipts.some((receipt) =>
    receipt.serviceId === line.serviceId))) {
    hold('BILLING_INVOICE_PAID_RECEIPT_COHORT_MISSING');
  }
  for (const serviceId of new Set(invoice.paidReceipts.map((row) => row.serviceId))) {
    const ambiguous = await tx.billingCreditUsageSettlement.findFirst({ where: {
      teamId: null, serviceId, billingMonth: invoice.billingMonth,
      creditAccount: { orgId: invoice.orgId },
    }, select: { id: true } });
    if (ambiguous) hold('BILLING_INVOICE_LEGACY_WALLET_LINEAGE_UNPROVEN');
    const receipts = invoice.paidReceipts.filter((row) => row.serviceId === serviceId);
    const allocation = invoice.lines.find((line) => line.serviceId === serviceId)
      ?.financialAllocation;
    const gross = receipts.reduce((sum, row) => sum + row.ratedMicrocredits, 0n);
    if (!allocation || (gross + 5_000_000n) / 10_000_000n !== allocation.usageMinor) {
      hold('BILLING_INVOICE_PAID_RECEIPT_AMOUNT_CHANGED');
    }
    for (const teamId of new Set(receipts.map((row) => row.teamId))) {
      const settled = await tx.billingCreditUsageSettlement.findMany({ where: {
        teamId, serviceId, billingMonth: invoice.billingMonth,
        creditAccount: { orgId: invoice.orgId },
      } });
      const debited = settled.reduce((sum, row) =>
        sum + row.cumulativeCreditsConsumedMicrocredits, 0n);
      const applied = invoice.creditSettlementRefs.filter((reference) =>
        reference.serviceId === serviceId && reference.settlement.teamId === teamId)
        .reduce((sum, reference) =>
          sum + reference.creditsAppliedMicrocredits, 0n);
      if (debited > applied) hold('BILLING_INVOICE_WALLET_CHANGED_BEFORE_ISSUE');
    }
  }
  if (invoice.paidReceipts.length > 0) {
    for (const dispatchId of invoice.paidReceipts.map((row) => row.dispatchId)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(
        hashtextextended('uoa-manual-paid-receipt:' || ${dispatchId}, 0))`);
    }
    const conflicts = await tx.billingInvoicePaidReceipt.findFirst({ where: {
      invoiceId: { not: invoiceId },
      dispatchId: { in: invoice.paidReceipts.map((row) => row.dispatchId) },
      invoice: { status: { in: [BillingInvoiceStatus.ISSUING,
        BillingInvoiceStatus.ISSUED] } },
    }, select: { id: true } });
    if (conflicts) hold('BILLING_INVOICE_PAID_RECEIPT_ALREADY_INVOICED');
  }
}
