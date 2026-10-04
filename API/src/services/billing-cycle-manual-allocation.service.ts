import { Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { allocateInvoiceCreditReferenceMinor } from './billing-invoice-line-credit-allocation.service.js';

export type FinancialInvoice = Prisma.BillingInvoiceGetPayload<{
  include: { lines: true; paymentEvents: true; lineFinancialAllocations: true;
    creditSettlementRefs: true; lineCreditAllocations: true };
}>;

function hold(): never {
  throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_MANUAL_INVOICE_ALLOCATION_UNPROVEN');
}

/** Validate every issuer-frozen service line before trusting one product's
 * allocated liability. The legal invoice's gross convention is preserved. */
export function verifiedManualInvoiceLine(invoice: FinancialInvoice,
  serviceId: string, month: string) {
  if (invoice.lines.length === 0 ||
    invoice.lineFinancialAllocations.length !== invoice.lines.length) hold();
  const byLine = new Map(invoice.lineFinancialAllocations.map((row) => [row.lineId, row]));
  if (byLine.size !== invoice.lines.length) hold();
  let subtotal = 0n;
  let gross = 0n;
  let tax = 0n;
  let credit = 0n;
  const creditByLine = new Map<string, bigint>();
  const calculatedCredits = allocateInvoiceCreditReferenceMinor(
    invoice.creditSettlementRefs.map((row) => ({ id: row.id, serviceId: row.serviceId,
      settlementId: row.settlementId,
      creditsAppliedMicrocredits: row.creditsAppliedMicrocredits })));
  const recordedCredits = new Map(invoice.lineCreditAllocations.map((row) =>
    [row.referenceId, row]));
  if (recordedCredits.size !== calculatedCredits.length ||
    invoice.lineCreditAllocations.length !== calculatedCredits.length) hold();
  for (const item of calculatedCredits) {
    const bound = recordedCredits.get(item.referenceId);
    const line = invoice.lines.find((row) => row.serviceId === item.serviceId);
    if (!bound || !line || bound.lineId !== line.id ||
      bound.invoiceId !== invoice.id || bound.amountMinor !== item.amountMinor) hold();
    creditByLine.set(line.id, (creditByLine.get(line.id) ?? 0n) + item.amountMinor);
  }
  for (const line of invoice.lines) {
    const row = byLine.get(line.id);
    if (!row || row.invoiceId !== invoice.id || row.serviceId !== line.serviceId ||
      row.billingMonth !== invoice.billingMonth || row.currency !== invoice.currency ||
      row.calculationDigest !== invoice.calculationDigest ||
      line.currency !== invoice.currency ||
      row.subscriptionMinor < 0n || row.usageMinor < 0n || row.taxMinor < 0n ||
      row.invoiceCreditMinor < 0n || row.invoiceCreditMinor > row.usageMinor ||
      row.subscriptionMinor + row.usageMinor !== line.amountMinor ||
      row.totalMinor !== line.amountMinor + row.taxMinor ||
      row.dueMinor !== row.totalMinor - row.invoiceCreditMinor ||
      row.invoiceCreditMinor !== (creditByLine.get(line.id) ?? 0n)) hold();
    subtotal += line.amountMinor;
    gross += row.totalMinor;
    tax += row.taxMinor;
    credit += row.invoiceCreditMinor;
  }
  if (invoice.subtotalMinor !== subtotal || invoice.taxAmountMinor !== tax ||
    invoice.totalMinor !== gross || invoice.creditsAppliedMinor !== credit ||
    gross < credit) hold();
  const line = invoice.lines.find((item) => item.serviceId === serviceId);
  const allocation = line ? byLine.get(line.id) : null;
  if (!line || !allocation || invoice.billingMonth !== month) hold();
  return { line, allocation, invoiceDueMinor: gross - credit,
    soleProduct: invoice.lines.length === 1 };
}
