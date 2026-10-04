import type { Prisma } from '@prisma/client';

import {
  BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH,
  type BillingCustomerInvoiceDetailV1,
  type BillingCustomerInvoiceSummaryV1,
  type BillingSubjectRequest,
} from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { cycleMoney } from './billing-cycle-quote-projection.service.js';
import { stripeInvoiceCashDigest } from './billing-stripe-payment-evidence.service.js';

export type StripePaymentInvoiceSource = Prisma.BillingStripePaymentInvoiceGetPayload<{
  include: { lines: true; subscription: true; cashPayments: true; adjustments: true };
}>;

function hold(): never {
  throw new AppError('INTERNAL', 503, 'BILLING_CUSTOMER_STRIPE_INVOICE_SOURCE_UNPROVEN');
}

function legalParty(value: Prisma.JsonValue | null): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).legal_name === 'string' &&
    Boolean((value as Record<string, unknown>).legal_name);
}

type Payment = { id: string; at: string; amount: bigint };
function verifiedPayments(row: StripePaymentInvoiceSource): Payment[] {
  const value = row.paymentEvidence;
  if (!Array.isArray(value) || value.length === 0) hold();
  let initialSum = 0n;
  let initialLatest = 0;
  const initialIds = new Set<string>();
  const initialIntentIds = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) hold();
    const initial = item as Record<string, unknown>;
    if (typeof initial.invoice_payment_id !== 'string' || !initial.invoice_payment_id ||
      typeof initial.payment_intent_id !== 'string' || !initial.payment_intent_id ||
      typeof initial.charge_id !== 'string' || !initial.charge_id ||
      typeof initial.amount_minor !== 'string' || !/^[1-9][0-9]*$/.test(initial.amount_minor) ||
      typeof initial.paid_at !== 'string' || !Number.isFinite(Date.parse(initial.paid_at)) ||
      new Date(initial.paid_at).toISOString() !== initial.paid_at ||
      initialIds.has(initial.invoice_payment_id) ||
      initialIntentIds.has(initial.payment_intent_id)) hold();
    initialIds.add(initial.invoice_payment_id);
    initialIntentIds.add(initial.payment_intent_id);
    initialSum += BigInt(initial.amount_minor);
    initialLatest = Math.max(initialLatest, Date.parse(initial.paid_at));
    const matched = row.cashPayments.find((payment) =>
      payment.stripeInvoicePaymentId === initial.invoice_payment_id);
    if (!matched || matched.stripePaymentIntentId !== initial.payment_intent_id ||
      matched.stripeChargeId !== initial.charge_id ||
      matched.amountMinor !== BigInt(initial.amount_minor) ||
      matched.paidAt.toISOString() !== initial.paid_at) hold();
  }
  if (initialSum !== row.paidAmountMinor || initialLatest !== row.paidAt.getTime() ||
    initialIntentIds.size !== row.stripePaymentIntentIds.length ||
    row.stripePaymentIntentIds.some((id) => !initialIntentIds.has(id)) ||
    row.cashPayments.length < initialIds.size) hold();
  const seen = new Set<string>();
  const seenIntents = new Set<string>();
  const payments = row.cashPayments.map((payment) => {
    if (payment.invoiceId !== row.id || payment.accountId !== row.accountId ||
      payment.livemode !== row.livemode || payment.currency !== row.currency ||
      payment.amountMinor <= 0n || seen.has(payment.stripeInvoicePaymentId) ||
      seenIntents.has(payment.stripePaymentIntentId) ||
      payment.evidenceDigest !== stripeInvoiceCashDigest({
        invoice_payment_id: payment.stripeInvoicePaymentId,
        payment_intent_id: payment.stripePaymentIntentId,
        charge_id: payment.stripeChargeId,
        amount_minor: payment.amountMinor.toString(),
        paid_at: payment.paidAt.toISOString(),
      })) hold();
    seen.add(payment.stripeInvoicePaymentId);
    seenIntents.add(payment.stripePaymentIntentId);
    return { id: payment.id, at: payment.paidAt.toISOString(), amount: payment.amountMinor };
  });
  const paid = payments.reduce((sum, payment) => sum + payment.amount, 0n);
  if (paid < row.paidAmountMinor || paid > row.dueAmountMinor) hold();
  return payments.sort((a, b) => Buffer.compare(Buffer.from(a.at), Buffer.from(b.at)) ||
    Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
}

function verifiedAdjustments(row: StripePaymentInvoiceSource, paid: bigint) {
  let refunded = 0n;
  let withdrawals = 0n;
  let reinstatements = 0n;
  for (const adjustment of row.adjustments) {
    if (adjustment.invoiceId !== row.id || adjustment.currency !== row.currency ||
      adjustment.amountMinor <= 0n || !row.cashPayments.some((payment) =>
        payment.stripePaymentIntentId === adjustment.stripePaymentIntentId &&
        payment.stripeChargeId === adjustment.stripeChargeId)) hold();
    if (adjustment.kind === 'REFUND') refunded += adjustment.amountMinor;
    else if (adjustment.kind === 'DISPUTE') withdrawals += adjustment.amountMinor;
    else if (adjustment.kind === 'DISPUTE_REVERSAL') reinstatements += adjustment.amountMinor;
    else hold();
  }
  const disputed = withdrawals - reinstatements;
  if (refunded < 0n || disputed < 0n || refunded + disputed > paid) hold();
  return { refunded, disputed };
}

export function projectStripeCustomerInvoiceSummary(
  row: StripePaymentInvoiceSource, product: string, serviceId: string,
  chargeMonth?: string,
): BillingCustomerInvoiceSummaryV1 {
  if (row.subscription.id !== row.subscriptionId ||
    row.subscription.accountId !== row.accountId ||
    row.subscription.livemode !== row.livemode ||
    row.subscription.orgId !== row.orgId || row.subscription.teamId !== row.teamId ||
    !/^[A-Z]{3}$/.test(row.currency) ||
    !row.stripeInvoiceId || !row.stripeCustomerId ||
    row.grossAmountMinor <= 0n || row.taxAmountMinor < 0n ||
    row.creditAmountMinor < 0n || row.creditAmountMinor > row.grossAmountMinor ||
    row.dueAmountMinor !== row.grossAmountMinor - row.creditAmountMinor ||
    row.paidAmountMinor > row.dueAmountMinor || row.paidAmountMinor <= 0n ||
    row.lines.length === 0 || row.lines.some((line) =>
      line.invoiceId !== row.id || line.serviceIdentifier !== product ||
      line.serviceId !== serviceId ||
      line.subscriptionMinor < 0n || line.usageMinor < 0n || line.taxMinor < 0n ||
      line.creditMinor < 0n || line.grossMinor < 0n || line.dueMinor < 0n ||
      line.grossMinor !== line.subscriptionMinor + line.usageMinor + line.taxMinor ||
      line.dueMinor !== line.grossMinor - line.creditMinor) ||
    row.lines.reduce((sum, line) => sum + line.grossMinor, 0n) !== row.grossAmountMinor ||
    row.lines.reduce((sum, line) => sum + line.taxMinor, 0n) !== row.taxAmountMinor ||
    row.lines.reduce((sum, line) => sum + line.creditMinor, 0n) !== row.creditAmountMinor ||
    row.lines.reduce((sum, line) => sum + line.dueMinor, 0n) !== row.dueAmountMinor) hold();
  const payments = verifiedPayments(row);
  const paid = payments.reduce((sum, payment) => sum + payment.amount, 0n);
  const selectedMonth = chargeMonth ?? payments.at(-1)?.at.slice(0, 7);
  if (!selectedMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(selectedMonth)) hold();
  const selectedPayments = payments.filter((payment) => payment.at.slice(0, 7) === selectedMonth);
  const paidInMonth = selectedPayments
    .reduce((sum, payment) => sum + payment.amount, 0n);
  if (paidInMonth === 0n) hold();
  const selectedAt = selectedPayments.at(-1)?.at ?? hold();
  const { refunded, disputed } = verifiedAdjustments(row, paid);
  const issued = row.state === 'ISSUED';
  if (issued && (!row.invoiceNumber || !row.issuedAt || !row.pdfObjectKey ||
    !row.pdfSha256 || !legalParty(row.issuerSnapshot) || !legalParty(row.buyerSnapshot))) hold();
  if (!issued && (row.invoiceNumber || row.issuedAt || row.pdfObjectKey || row.pdfSha256)) hold();
  const currency = row.currency;
  const zero = cycleMoney(0n, currency);
  const status = !issued ? 'pending_document' : disputed > 0n ?
    disputed === paid && paid === row.dueAmountMinor ? 'disputed' : 'partially_disputed' :
    refunded > 0n ? refunded === paid && paid === row.dueAmountMinor ?
      'refunded' : 'partially_refunded' :
      paid === row.dueAmountMinor ? 'paid' : 'partially_paid';
  return { invoice_id: `stripe:${row.id}`, kind: 'monthly_service', status,
    number: issued ? row.invoiceNumber : null,
    charged_at: selectedAt, issued_at: issued ? row.issuedAt?.toISOString() ?? null : null,
    charge_month: selectedMonth, payments_in_charge_month: cycleMoney(paidInMonth, row.currency),
    scope: { organisation_id: row.orgId, team_id: row.teamId,
      scope_type: row.teamId === null ? 'organisation' : 'team' },
    product_identifiers: [product],
    totals: { currency, gross_total: cycleMoney(row.grossAmountMinor, currency),
      tax: cycleMoney(row.taxAmountMinor, currency),
      credits_applied: cycleMoney(row.creditAmountMinor, currency), voided_amount: zero,
      total_due: cycleMoney(row.dueAmountMinor, currency),
      total_paid: cycleMoney(paid, currency),
      refunded_amount: cycleMoney(refunded, currency),
      disputed_amount: cycleMoney(disputed, currency), write_off: zero,
      outstanding: cycleMoney(row.dueAmountMinor - paid, currency) },
    document_available: issued };
}

export function projectStripeCustomerInvoiceDetail(
  row: StripePaymentInvoiceSource, product: string, serviceId: string,
  subject: BillingSubjectRequest,
  chargeMonth?: string,
): BillingCustomerInvoiceDetailV1 {
  const summary = projectStripeCustomerInvoiceSummary(row, product, serviceId, chargeMonth);
  if (subject.product !== product || subject.organisation_id !== row.orgId ||
    (row.teamId !== null && subject.team_id !== row.teamId)) hold();
  const invoiceId = `stripe:${row.id}`;
  return { ...summary, schema_version: 1,
    payments: verifiedPayments(row)
      .map((payment) => ({ payment_id: payment.id, paid_at: payment.at,
        amount: cycleMoney(payment.amount, row.currency) })),
    charges: [...row.lines].sort((a, b) => Buffer.compare(Buffer.from(a.stripeLineId),
      Buffer.from(b.stripeLineId))).map((line) => ({ line_id: line.id,
      kind: 'service_charge' as const, label: line.label,
      amount: cycleMoney(line.subscriptionMinor + line.usageMinor, row.currency),
      credits_purchased: null })),
    document: summary.document_available && summary.number && summary.issued_at ? {
      document_id: invoiceId, format: 'pdf', number: summary.number,
      issued_at: summary.issued_at,
      download_action: { method: 'POST', path: BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH,
        body: { ...subject, invoice_id: invoiceId, document_id: invoiceId } },
    } : null };
}
