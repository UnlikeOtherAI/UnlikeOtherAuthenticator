import { createHash } from 'node:crypto';

import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { assertStripeObjectLivemode } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

export type StripeInvoiceCashClient = Pick<Stripe, 'invoices' | 'invoicePayments' | 'paymentIntents' | 'charges'>;
export type StripeInvoiceCashEvidence = {
  invoice_payment_id: string; payment_intent_id: string; charge_id: string;
  amount_minor: string; paid_at: string;
};

export function stripeInvoiceCashDigest(payment: StripeInvoiceCashEvidence): string {
  return createHash('sha256').update([payment.invoice_payment_id, payment.payment_intent_id,
    payment.charge_id, payment.amount_minor, payment.paid_at]
    .map((value) => `${Buffer.byteLength(value)}:${value}`).join('')).digest('hex');
}

export function stripeInvoiceMinor(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_INVOICE_AMOUNT_UNPROVEN');
  }
  return BigInt(value);
}

function paidTime(value: number | null): Date {
  if (!value || !Number.isSafeInteger(value) || value <= 0) {
    throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_PAYMENT_TIME_UNPROVEN');
  }
  const at = new Date(value * 1000);
  if (Number.isNaN(at.getTime())) {
    throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_PAYMENT_TIME_UNPROVEN');
  }
  return at;
}

/** A manually marked-paid invoice does not prove a cash payment. */
export async function verifyStripeInvoiceCash(
  invoice: Stripe.Invoice, stripe: StripeInvoiceCashClient,
): Promise<{ payments: StripeInvoiceCashEvidence[]; paidAt: Date }> {
  const payments: StripeInvoiceCashEvidence[] = [];
  const paymentIds = new Set<string>();
  const intentIds = new Set<string>();
  let after: string | undefined;
  let complete = false;
  for (let page = 0; page < 10; page += 1) {
    const rows = await stripe.invoicePayments.list({ invoice: invoice.id, status: 'paid',
      limit: 100, ...(after ? { starting_after: after } : {}) });
    for (const payment of rows.data) {
      assertStripeObjectLivemode(payment, invoice.livemode);
      const intentId = stripeExternalId(payment.payment.payment_intent ?? null);
      if (stripeExternalId(payment.invoice) !== invoice.id || payment.status !== 'paid' ||
        payment.currency !== invoice.currency || payment.payment.type !== 'payment_intent' ||
        !intentId || payment.amount_paid === null || payment.amount_paid <= 0 ||
        paymentIds.has(payment.id) || intentIds.has(intentId)) {
        throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_PAYMENT_BINDING_UNPROVEN');
      }
      const amount = stripeInvoiceMinor(payment.amount_paid);
      const paidAt = paidTime(payment.status_transitions.paid_at);
      const intent = await stripe.paymentIntents.retrieve(intentId);
      assertStripeObjectLivemode(intent, invoice.livemode);
      const chargeId = stripeExternalId(intent.latest_charge);
      if (intent.id !== intentId || intent.status !== 'succeeded' ||
        stripeExternalId(intent.customer) !== stripeExternalId(invoice.customer) ||
        intent.currency !== invoice.currency || stripeInvoiceMinor(intent.amount_received) !== amount ||
        !chargeId) {
        throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_PAYMENT_CASH_UNPROVEN');
      }
      const charge = await stripe.charges.retrieve(chargeId);
      assertStripeObjectLivemode(charge, invoice.livemode);
      if (charge.id !== chargeId || stripeExternalId(charge.payment_intent) !== intentId ||
        stripeExternalId(charge.customer) !== stripeExternalId(invoice.customer) ||
        charge.currency !== invoice.currency || charge.status !== 'succeeded' ||
        !charge.paid || !charge.captured || stripeInvoiceMinor(charge.amount_captured) !== amount) {
        throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_PAYMENT_CHARGE_UNPROVEN');
      }
      paymentIds.add(payment.id); intentIds.add(intentId);
      payments.push({ invoice_payment_id: payment.id, payment_intent_id: intentId,
        charge_id: chargeId, amount_minor: amount.toString(), paid_at: paidAt.toISOString() });
    }
    if (!rows.has_more) { complete = true; break; }
    after = rows.data.at(-1)?.id;
    if (!after) break;
  }
  if (!complete || payments.length === 0 ||
    payments.reduce((sum, row) => sum + BigInt(row.amount_minor), 0n) !==
      stripeInvoiceMinor(invoice.amount_paid)) {
    throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_PAYMENT_SET_UNPROVEN');
  }
  payments.sort((a, b) => Buffer.compare(Buffer.from(a.invoice_payment_id),
    Buffer.from(b.invoice_payment_id)));
  return { payments, paidAt: new Date(Math.max(...payments.map((row) => Date.parse(row.paid_at)))) };
}
