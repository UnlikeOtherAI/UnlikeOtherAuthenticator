import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { billingStatementCopy } from './billing-statement-copy.catalog.js';
import type { Prisma } from '@prisma/client';

import { BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH,
  type BillingCustomerInvoiceDetailV1, type BillingCustomerInvoiceSummaryV1,
  type BillingSubjectRequest } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { cycleMoney } from './billing-cycle-quote-projection.service.js';

export type CreditNoteSource = Prisma.BillingManualCreditNoteGetPayload<{
  include: { originalInvoice: { include: { lines: true; paymentEvents: true } } };
}>;

function hold(): never {
  throw new AppError('INTERNAL', 503, 'BILLING_CUSTOMER_CREDIT_NOTE_UNPROVEN');
}

function checked(note: CreditNoteSource): asserts note is CreditNoteSource & {
  creditNoteNumber: string; issuedAt: Date; pdfObjectKey: string; pdfSha256: string;
} {
  const invoice = note.originalInvoice;
  if (note.status !== 'ISSUED' || !note.creditNoteNumber || !note.issuedAt ||
    !note.pdfObjectKey || !note.pdfSha256 || invoice.lines.length !== 1 ||
    invoice.lines[0]?.serviceId !== note.serviceId || invoice.orgId !== note.orgId ||
    invoice.currency !== note.currency || invoice.billingMonth !== note.billingMonth ||
    invoice.subtotalMinor !== note.netCreditMinor ||
    invoice.taxAmountMinor !== note.taxCreditMinor ||
    invoice.totalMinor !== note.totalCreditMinor ||
    invoice.creditsAppliedMinor !== 0n) hold();
}

export function projectCustomerCreditNoteSummary(note: CreditNoteSource,
  chargeMonth: string): BillingCustomerInvoiceSummaryV1 {
  checked(note);
  if (note.issuedAt.toISOString().slice(0, 7) !== chargeMonth) hold();
  let paid = 0n;
  let refunded = 0n;
  for (const event of note.originalInvoice.paymentEvents) {
    if (event.currency !== note.currency || event.amountMinor <= 0n) hold();
    if (event.kind === 'PAYMENT') paid += event.amountMinor;
    else if (event.kind === 'REFUND') refunded += event.amountMinor;
    else if (event.kind !== 'WRITE_OFF') hold();
  }
  if (refunded > paid || paid > note.totalCreditMinor) hold();
  const money = (amount: bigint) => cycleMoney(amount, note.currency);
  return {
    invoice_id: `credit_note:${note.id}`, kind: 'credit_note', status: 'issued',
    number: note.creditNoteNumber, charged_at: note.issuedAt.toISOString(),
    charge_month: chargeMonth, payments_in_charge_month: money(0n),
    issued_at: note.issuedAt.toISOString(),
    scope: { organisation_id: note.orgId, team_id: null, scope_type: 'organisation' },
    product_identifiers: [note.originalInvoice.lines[0]?.serviceIdentifier ?? hold()],
    totals: { currency: note.currency, gross_total: money(note.totalCreditMinor),
      tax: money(note.taxCreditMinor), credits_applied: money(0n),
      voided_amount: money(note.totalCreditMinor), total_due: money(0n),
      total_paid: money(0n), refunded_amount: money(0n), disputed_amount: money(0n),
      write_off: money(0n), outstanding: money(0n),
      customer_credit_due: money(paid - refunded) },
    document_available: true,
  };
}

export function projectCustomerCreditNoteDetail(note: CreditNoteSource,
  subject: BillingSubjectRequest, chargeMonth?: string, locale?: BillingCustomerLocale): BillingCustomerInvoiceDetailV1 {
  checked(note);
  if (subject.organisation_id !== note.orgId ||
    note.originalInvoice.lines[0]?.serviceIdentifier !== subject.product) hold();
  const summary = projectCustomerCreditNoteSummary(note,
    chargeMonth ?? note.issuedAt.toISOString().slice(0, 7));
  const id = `credit_note:${note.id}`;
  return { ...summary, schema_version: 1, payments: [],
    charges: [{ line_id: note.originalInvoice.lines[0]?.id ?? hold(),
      kind: 'adjustment', label: billingStatementCopy(locale).cancelledInvoice,
      amount: cycleMoney(note.totalCreditMinor, note.currency),
      credits_purchased: null }],
    document: { document_id: id, format: 'pdf', number: note.creditNoteNumber,
      issued_at: note.issuedAt.toISOString(),
      download_action: { method: 'POST', path: BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH,
        body: { ...subject, invoice_id: id, document_id: id } } },
  };
}
