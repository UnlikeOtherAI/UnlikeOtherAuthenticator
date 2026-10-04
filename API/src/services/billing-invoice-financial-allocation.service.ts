import type { Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { allocateInvoiceCreditReferenceMinor } from './billing-invoice-line-credit-allocation.service.js';

type LineAmount = {
  serviceId: string;
  subscriptionMinor: bigint;
  usageMinor: bigint;
  taxMinor?: bigint;
};

/** Freeze every service's actual liability and its settled-credit cents with the draft. */
export async function writeInvoiceFinancialAllocations(
  tx: Prisma.TransactionClient,
  invoice: {
    id: string;
    billingMonth: string;
    currency: string;
    calculationDigest: string;
    lines: Array<{ id: string; serviceId: string; amountMinor: bigint }>;
  },
  amounts: readonly LineAmount[],
): Promise<void> {
  const references = await tx.billingInvoiceCreditSettlementReference.findMany({
    where: { invoiceId: invoice.id },
    select: { id: true, serviceId: true, settlementId: true, creditsAppliedMicrocredits: true },
  });
  const allocations = allocateInvoiceCreditReferenceMinor(references);
  const lineByService = new Map(invoice.lines.map((line) => [line.serviceId, line]));
  const amountByService = new Map(amounts.map((amount) => [amount.serviceId, amount]));
  if (lineByService.size !== invoice.lines.length || amountByService.size !== amounts.length ||
    amountByService.size !== lineByService.size) {
    throw new AppError('INTERNAL', 500, 'BILLING_INVOICE_ALLOCATION_SOURCE_INVALID');
  }
  const creditsByService = new Map<string, bigint>();
  for (const allocation of allocations) {
    creditsByService.set(allocation.serviceId,
      (creditsByService.get(allocation.serviceId) ?? 0n) + allocation.amountMinor);
  }
  for (const line of invoice.lines) {
    const amount = amountByService.get(line.serviceId);
    if (!amount || amount.subscriptionMinor + amount.usageMinor !== line.amountMinor) {
      throw new AppError('INTERNAL', 500, 'BILLING_INVOICE_ALLOCATION_SOURCE_INVALID');
    }
    const credit = creditsByService.get(line.serviceId) ?? 0n;
    if (credit < 0n || credit > amount.usageMinor) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_CREDIT_EXCEEDS_USAGE');
    }
    await tx.billingInvoiceLineFinancialAllocation.create({ data: {
      lineId: line.id,
      invoiceId: invoice.id,
      serviceId: line.serviceId,
      billingMonth: invoice.billingMonth,
      subscriptionMinor: amount.subscriptionMinor,
      usageMinor: amount.usageMinor,
      taxMinor: amount.taxMinor ?? 0n,
      invoiceCreditMinor: credit,
      totalMinor: line.amountMinor + (amount.taxMinor ?? 0n),
      dueMinor: line.amountMinor + (amount.taxMinor ?? 0n) - credit,
      currency: invoice.currency,
      calculationDigest: invoice.calculationDigest,
    } });
  }
  for (const allocation of allocations) {
    const line = lineByService.get(allocation.serviceId);
    if (!line) throw new AppError('INTERNAL', 500, 'BILLING_INVOICE_CREDIT_SERVICE_INVALID');
    await tx.billingInvoiceLineCreditReferenceAllocation.create({ data: {
      referenceId: allocation.referenceId,
      invoiceId: invoice.id,
      lineId: line.id,
      amountMinor: allocation.amountMinor,
    } });
  }
}
