import type { BillingCreditPaymentInvoice } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { assertStripeObjectLivemode } from './billing-stripe-client.service.js';

type StripeReader = Pick<Stripe, 'checkout' | 'invoicePayments' | 'invoices'>;
export type VerifiedStripePaymentInvoice = {
  invoiceId: string;
  number: string;
  issuedAt: Date;
  taxMinor: bigint;
  accountName: string;
  accountCountry: string;
  buyerName: string;
  buyerEmail: string;
  buyerCountry: string;
  buyerAddress: {
    line1: string | null;
    city: string | null;
    postal_code: string | null;
  };
  pdf: Uint8Array;
};

function externalId(value: string | { id: string } | null): string | null {
  return value === null ? null : typeof value === 'string' ? value : value.id;
}

function exactMinor(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('INTERNAL', 502, 'STRIPE_PAYMENT_INVOICE_AMOUNT_INVALID');
  }
  return BigInt(value);
}

function pdfUrl(value: string | null | undefined): URL {
  if (!value) throw new AppError('INTERNAL', 409, 'STRIPE_PAYMENT_INVOICE_PDF_PENDING');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'pay.stripe.com' ||
      !url.pathname.startsWith('/invoice/')) {
    throw new AppError('INTERNAL', 502, 'STRIPE_PAYMENT_INVOICE_PDF_URL_INVALID');
  }
  return url;
}

// A Stripe invoice wins over a UOA-issued document only when the exact
// PaymentIntent is its sole paid financial source. An ambiguous or unfinished
// provider document is held; UOA must not issue a second legal invoice.
export async function resolveExistingStripePaymentInvoice(
  source: BillingCreditPaymentInvoice,
  stripe: StripeReader,
  download: typeof fetch = fetch,
  checkoutSessionId?: string | null,
): Promise<VerifiedStripePaymentInvoice | null> {
  let checkoutInvoiceId: string | null = null;
  if (checkoutSessionId) {
    const checkout = await stripe.checkout.sessions.retrieve(checkoutSessionId);
    assertStripeObjectLivemode(checkout, source.livemode);
    if (checkout.id !== checkoutSessionId || checkout.mode !== 'payment' ||
        checkout.status !== 'complete' || checkout.payment_status !== 'paid' ||
        externalId(checkout.payment_intent) !== source.stripePaymentIntentId ||
        externalId(checkout.customer) !== source.stripeCustomerId ||
        checkout.currency?.toUpperCase() !== source.currency ||
        checkout.amount_total === null ||
        exactMinor(checkout.amount_total) !== source.grossAmountMinor) {
      throw new AppError('INTERNAL', 409, 'STRIPE_PAYMENT_CHECKOUT_FACTS_INVALID');
    }
    checkoutInvoiceId = externalId(checkout.invoice);
  }
  const matches = await stripe.invoicePayments.list({
    payment: { type: 'payment_intent', payment_intent: source.stripePaymentIntentId },
    limit: 2,
  });
  if (matches.data.length === 0 && !matches.has_more) {
    if (checkoutInvoiceId) {
      throw new AppError('INTERNAL', 409, 'STRIPE_PAYMENT_INVOICE_PENDING');
    }
    return null;
  }
  if (matches.data.length !== 1 || matches.has_more) {
    throw new AppError('INTERNAL', 409, 'STRIPE_PAYMENT_INVOICE_MULTIPLE_BINDINGS');
  }
  const payment = matches.data[0];
  if (!payment) {
    throw new AppError('INTERNAL', 409, 'STRIPE_PAYMENT_INVOICE_BINDING_MISSING');
  }
  assertStripeObjectLivemode(payment, source.livemode);
  const invoiceId = externalId(payment.invoice);
  if (!invoiceId || (checkoutInvoiceId && checkoutInvoiceId !== invoiceId) ||
      payment.status !== 'paid' ||
      payment.payment.type !== 'payment_intent' ||
      externalId(payment.payment.payment_intent ?? null) !== source.stripePaymentIntentId ||
      payment.amount_paid === null || exactMinor(payment.amount_paid) !== source.grossAmountMinor ||
      payment.currency.toUpperCase() !== source.currency) {
    throw new AppError('INTERNAL', 409, 'STRIPE_PAYMENT_INVOICE_BINDING_INVALID');
  }
  const invoice = await stripe.invoices.retrieve(invoiceId);
  assertStripeObjectLivemode(invoice, source.livemode);
  if (invoice.id !== invoiceId || invoice.status !== 'paid' ||
      externalId(invoice.customer) !== source.stripeCustomerId ||
      invoice.currency.toUpperCase() !== source.currency ||
      exactMinor(invoice.total) !== source.grossAmountMinor ||
      exactMinor(invoice.amount_paid) !== source.grossAmountMinor ||
      invoice.amount_remaining !== 0 ||
      !invoice.number || !invoice.account_name || !invoice.account_country ||
      !invoice.customer_name || !invoice.customer_email ||
      !invoice.customer_address?.country ||
      !invoice.status_transitions.finalized_at ||
      invoice.total_taxes === null) {
    throw new AppError('INTERNAL', 409, 'STRIPE_PAYMENT_INVOICE_FACTS_INCOMPLETE');
  }
  const taxMinor = invoice.total_taxes.reduce(
    (sum, tax) => sum + exactMinor(tax.amount), 0n,
  );
  if (taxMinor > source.grossAmountMinor) {
    throw new AppError('INTERNAL', 409, 'STRIPE_PAYMENT_INVOICE_TAX_INVALID');
  }
  const url = pdfUrl(invoice.invoice_pdf);
  const response = await download(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new AppError('INTERNAL', 503, 'STRIPE_PAYMENT_INVOICE_PDF_UNAVAILABLE');
  }
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (contentLength > 5_000_000) {
    throw new AppError('INTERNAL', 502, 'STRIPE_PAYMENT_INVOICE_PDF_TOO_LARGE');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 5_000_000 || bytes.length < 8 ||
      new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new AppError('INTERNAL', 502, 'STRIPE_PAYMENT_INVOICE_PDF_INVALID');
  }
  return {
    invoiceId,
    number: invoice.number,
    issuedAt: new Date(invoice.status_transitions.finalized_at * 1000),
    taxMinor,
    accountName: invoice.account_name,
    accountCountry: invoice.account_country,
    buyerName: invoice.customer_name,
    buyerEmail: invoice.customer_email,
    buyerCountry: invoice.customer_address.country,
    buyerAddress: {
      line1: invoice.customer_address.line1,
      city: invoice.customer_address.city,
      postal_code: invoice.customer_address.postal_code,
    },
    pdf: bytes,
  };
}
