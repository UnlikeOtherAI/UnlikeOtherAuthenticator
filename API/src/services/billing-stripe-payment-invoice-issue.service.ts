import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { type StripeAccountContext } from './billing-stripe-client.service.js';
import { downloadStripeInvoicePdf } from './billing-stripe-invoice-document.service.js';
import { createBillingInvoicePdfStorage, type BillingInvoicePdfStorage } from './billing-invoice-storage.service.js';
import { prepareStripePaymentInvoice } from './billing-stripe-payment-invoice-source.service.js';
import { type StripeInvoiceCashClient } from './billing-stripe-payment-evidence.service.js';

type Provider = StripeInvoiceCashClient & Pick<Stripe, 'subscriptions'>;

export async function issueStripePaymentInvoice(id: string, deps: {
  prisma: PrismaClient; stripe: Provider; account: StripeAccountContext;
  storage?: BillingInvoicePdfStorage; download?: typeof fetch;
}) {
  const source = await deps.prisma.billingStripePaymentInvoice.findUniqueOrThrow({ where: { id } });
  if (source.accountId !== deps.account.id || source.livemode !== deps.account.livemode) {
    throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_INVOICE_ACCOUNT_MISMATCH');
  }
  if (source.state === 'ISSUED') return source;
  const verified = await prepareStripePaymentInvoice(source.stripeInvoiceId,
    deps.account, deps.prisma, deps.stripe);
  if (!verified || verified.sourceDigest !== source.sourceDigest) {
    throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_INVOICE_SOURCE_CHANGED');
  }
  const invoice = verified.invoice;
  if (invoice.id !== source.stripeInvoiceId || invoice.livemode !== source.livemode ||
    (invoice.status !== 'paid' && invoice.status !== 'open') || !invoice.number || !invoice.account_name || !invoice.account_country ||
    !invoice.customer_name || !invoice.customer_address?.country ||
    !invoice.status_transitions.finalized_at || invoice.number.length > 80) {
    throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_INVOICE_LEGAL_FACTS_PENDING');
  }
  const bytes = await downloadStripeInvoicePdf(invoice.invoice_pdf, deps.download);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const key = `billing-invoices/stripe-payments/${source.id}/${sha}.pdf`;
  const storage = deps.storage ?? createBillingInvoicePdfStorage();
  try { await storage.putImmutable(key, bytes); } catch (error) {
    if (!(error instanceof AppError) || error.message !== 'BILLING_INVOICE_PDF_ALREADY_EXISTS') throw error;
    const stored = await storage.read(key);
    if (createHash('sha256').update(stored).digest('hex') !== sha) {
      throw new AppError('INTERNAL', 503, 'STRIPE_SUBSCRIPTION_INVOICE_DOCUMENT_INTEGRITY');
    }
  }
  await deps.prisma.billingStripePaymentInvoice.updateMany({ where: { id, state: { not: 'ISSUED' },
    sourceDigest: source.sourceDigest }, data: { state: 'ISSUED', holdReason: null,
    invoiceNumber: invoice.number,
    issuedAt: new Date((invoice.effective_at ?? invoice.status_transitions.finalized_at) * 1000),
    issuerSnapshot: { legal_name: invoice.account_name, country: invoice.account_country,
      stripe_account_id: deps.account.stripeAccountId },
    buyerSnapshot: { legal_name: invoice.customer_name, billing_email: invoice.customer_email,
      billing_address: { ...invoice.customer_address } },
    pdfObjectKey: key, pdfSha256: sha } });
  const final = await deps.prisma.billingStripePaymentInvoice.findUniqueOrThrow({ where: { id } });
  if (final.pdfObjectKey !== key || final.pdfSha256 !== sha || final.state !== 'ISSUED') {
    throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_INVOICE_DOCUMENT_CHANGED');
  }
  return final;
}
