import { BillingInvoiceStatus, type Prisma } from '@prisma/client';

import {
  BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH,
  type BillingCustomerInvoiceDetailV1,
  type BillingCustomerInvoiceSummaryV1,
  type BillingSubjectRequest,
} from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { cycleMoney } from './billing-cycle-quote-projection.service.js';

export type ManualInvoiceSource = Prisma.BillingInvoiceGetPayload<{
  include: { lines: true; paymentEvents: true };
}>;

function hold(): never {
  throw new AppError('INTERNAL', 503, 'BILLING_CUSTOMER_INVOICE_SOURCE_UNPROVEN');
}

function legalParty(value: Prisma.JsonValue): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).legal_name === 'string' &&
    Boolean((value as Record<string, unknown>).legal_name);
}

function financials(invoice: ManualInvoiceSource) {
  let paid = 0n;
  let writeOff = 0n;
  let refunded = 0n;
  for (const event of invoice.paymentEvents) {
    if (event.currency !== invoice.currency || event.amountMinor <= 0n) hold();
    if (event.kind === 'PAYMENT') paid += event.amountMinor;
    else if (event.kind === 'REFUND') refunded += event.amountMinor;
    else if (event.kind === 'WRITE_OFF') writeOff += event.amountMinor;
    else hold();
  }
  const originalDue = invoice.totalMinor - invoice.creditsAppliedMinor;
  const voided = invoice.status === BillingInvoiceStatus.VOID;
  const due = voided ? 0n : originalDue;
  const outstanding = due - paid - writeOff;
  if (originalDue < 0n || paid < 0n || refunded > paid || outstanding < 0n ||
    (voided && invoice.paymentEvents.length > 0)) hold();
  const status = voided ? 'voided' :
    refunded > 0n ? refunded === paid && outstanding === 0n ? 'refunded' :
      'partially_refunded' :
    writeOff > 0n && outstanding === 0n ? 'written_off' :
      paid === due ? 'paid' :
          paid > 0n ? 'partially_paid' : 'issued';
  return { paid, refunded, writeOff, due, outstanding,
    voidedAmount: voided ? originalDue : 0n, status } as const;
}

export function projectManualCustomerInvoiceSummary(
  invoice: ManualInvoiceSource,
): BillingCustomerInvoiceSummaryV1 {
  if ((invoice.status !== BillingInvoiceStatus.ISSUED &&
    invoice.status !== BillingInvoiceStatus.VOID) ||
    !invoice.invoiceNumber || !invoice.issuedAt || !invoice.issueDate ||
    !invoice.pdfObjectKey || !invoice.pdfSha256 ||
    !legalParty(invoice.issuerSnapshot) || !legalParty(invoice.buyerSnapshot) ||
    invoice.lines.length === 0 || invoice.lines.some((line) =>
      line.currency !== invoice.currency || line.amountMinor < 0n) ||
    invoice.lines.reduce((sum, line) => sum + line.amountMinor, 0n) !==
      invoice.subtotalMinor ||
    invoice.subtotalMinor + invoice.taxAmountMinor !== invoice.totalMinor) hold();
  const amounts = financials(invoice);
  return {
    invoice_id: `manual:${invoice.id}`, kind: 'monthly_service', status: amounts.status,
    number: invoice.invoiceNumber, charged_at: invoice.issuedAt.toISOString(),
    issued_at: invoice.issuedAt.toISOString(),
    scope: { organisation_id: invoice.orgId, team_id: null,
      scope_type: 'organisation' },
    product_identifiers: [...new Set(invoice.lines.map((line) => line.serviceIdentifier))]
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    totals: { currency: invoice.currency,
      gross_total: cycleMoney(invoice.totalMinor, invoice.currency),
      tax: cycleMoney(invoice.taxAmountMinor, invoice.currency),
      credits_applied: cycleMoney(invoice.creditsAppliedMinor, invoice.currency),
      voided_amount: cycleMoney(amounts.voidedAmount, invoice.currency),
      total_due: cycleMoney(amounts.due, invoice.currency),
      total_paid: cycleMoney(amounts.paid, invoice.currency),
      refunded_amount: cycleMoney(amounts.refunded, invoice.currency),
      disputed_amount: cycleMoney(0n, invoice.currency),
      write_off: cycleMoney(amounts.writeOff, invoice.currency),
      outstanding: cycleMoney(amounts.outstanding, invoice.currency) },
    document_available: true,
  };
}

export function projectManualCustomerInvoiceDetail(
  invoice: ManualInvoiceSource, subject: BillingSubjectRequest,
): BillingCustomerInvoiceDetailV1 {
  const summary = projectManualCustomerInvoiceSummary(invoice);
  const number = summary.number;
  const issuedAt = summary.issued_at;
  if (!number || !issuedAt) hold();
  if (subject.organisation_id !== invoice.orgId ||
    invoice.lines.some((line) => line.serviceIdentifier !== subject.product)) hold();
  return { ...summary, schema_version: 1,
    charges: [...invoice.lines].sort((a, b) => a.position - b.position)
      .map((line) => ({ line_id: line.id, kind: 'service_charge' as const,
        label: line.serviceName, amount: cycleMoney(line.amountMinor, invoice.currency),
        credits_purchased: null })),
    document: { document_id: `manual:${invoice.id}`, format: 'pdf',
      number, issued_at: issuedAt,
      download_action: { method: 'POST', path: BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH,
        body: { ...subject, invoice_id: `manual:${invoice.id}`,
          document_id: `manual:${invoice.id}` } } },
  };
}
