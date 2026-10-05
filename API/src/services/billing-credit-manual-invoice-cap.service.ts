import { BillingInvoiceStatus, type Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

/** Returns cash liability already bound to exact issued manual receipts for
 * one source team. An older invoice without a frozen paid cohort holds rather
 * than assigning organisation-wide usage to a guessed team. */
export async function manualInvoiceReservedMicroMinor(
  tx: Prisma.TransactionClient,
  params: { orgId: string; teamId: string; serviceId: string;
    billingMonth: string; creditAccountId: string },
): Promise<bigint> {
  const lines = await tx.billingInvoiceLineFinancialAllocation.findMany({ where: {
    serviceId: params.serviceId, billingMonth: params.billingMonth,
    invoice: { orgId: params.orgId, status: { in: [BillingInvoiceStatus.ISSUING,
      BillingInvoiceStatus.ISSUED] } },
  }, include: { invoice: { include: {
    paidReceipts: { where: { serviceId: params.serviceId } },
    creditSettlementRefs: { where: { serviceId: params.serviceId },
      include: { settlement: { select: { teamId: true, creditAccountId: true } } } },
  } } } });
  let reserved = 0n;
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.usageMinor === 0n) continue;
    const receipts = line.invoice.paidReceipts;
    const total = receipts.reduce((sum, row) => sum + row.ratedMicrocredits, 0n);
    if (receipts.length === 0 || (total + 5_000_000n) / 10_000_000n !== line.usageMinor ||
      receipts.some((row) => row.invoiceId !== line.invoiceId ||
        row.orgId !== params.orgId || row.billingMonth !== params.billingMonth ||
        row.serviceId !== params.serviceId || seen.has(row.dispatchId))) {
      hold('BILLING_CREDIT_MANUAL_INVOICE_COHORT_UNPROVEN');
    }
    for (const row of receipts) seen.add(row.dispatchId);
    const teamRated = receipts.filter((row) => row.teamId === params.teamId)
      .reduce((sum, row) => sum + row.ratedMicrocredits, 0n);
    const teamCredits = line.invoice.creditSettlementRefs.filter((row) =>
      row.settlement.teamId === params.teamId &&
      row.settlement.creditAccountId === params.creditAccountId)
      .reduce((sum, row) => {
        const delta = row.creditsAppliedMicrocredits -
          row.priorCreditsAppliedMicrocredits;
        if (delta < 0n) hold('BILLING_CREDIT_MANUAL_INVOICE_CREDIT_SCOPE_UNPROVEN');
        return sum + delta;
      }, 0n);
    if (teamCredits > teamRated) {
      hold('BILLING_CREDIT_MANUAL_INVOICE_CREDIT_SCOPE_UNPROVEN');
    }
    reserved += (teamRated - teamCredits) / 10n;
  }
  return reserved;
}
