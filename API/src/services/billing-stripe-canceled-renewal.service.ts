import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { assertStripeObjectLivemode } from './billing-stripe-client.service.js';
import { verifyStripePaymentInvoiceLines } from './billing-stripe-payment-lines.service.js';
import { quoteUnexportedClosedPeriodLiability }
  from './billing-stripe-invoice-close-quote.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

/** Cancellation disables automatic collection on existing invoices too.
 * Resume the same verified earned obligation; never create another seat fee. */
export async function resumeCanceledStripeRenewal(params: {
  sourceId: string; subscriptionId: string;
}, deps: { prisma: PrismaClient; stripe: Pick<Stripe, 'invoices'>;
  quoteUsage?: typeof quoteUnexportedClosedPeriodLiability }) {
  const source = await deps.prisma.billingStripeMonthlyCharge.findUniqueOrThrow({
    where: { id: params.sourceId } });
  const subscription = await deps.prisma.billingStripeSubscription.findUniqueOrThrow({
    where: { id: params.subscriptionId }, include: { customer: true } });
  if (source.subscriptionId !== subscription.id || source.allocationKind !== 'RENEWAL' ||
    source.state !== 'ACCEPTED' || !source.stripeInvoiceId || !source.stripeInvoiceItemId ||
    subscription.status !== 'canceled' || source.accountId !== subscription.accountId ||
    !subscription.customer.stripeCustomerId) {
    throw new AppError('INTERNAL', 409, 'STRIPE_CANCELED_RENEWAL_SOURCE_UNPROVEN');
  }
  const invoice = await deps.stripe.invoices.retrieve(source.stripeInvoiceId);
  assertStripeObjectLivemode(invoice, subscription.livemode);
  const parent = invoice.parent?.type === 'subscription_details' ?
    stripeExternalId(invoice.parent.subscription_details?.subscription ?? null) : null;
  if (invoice.id !== source.stripeInvoiceId || parent !== subscription.stripeSubscriptionId ||
    stripeExternalId(invoice.customer) !== subscription.customer.stripeCustomerId ||
    invoice.currency.toUpperCase() !== source.currency ||
    invoice.collection_method !== 'charge_automatically' ||
    !['draft', 'open', 'paid'].includes(invoice.status ?? '')) {
    throw new AppError('INTERNAL', 409, 'STRIPE_CANCELED_RENEWAL_INVOICE_UNPROVEN');
  }
  const lines = await verifyStripePaymentInvoiceLines({ invoice, accountId: subscription.accountId,
    subscriptionId: subscription.id, orgId: subscription.orgId,
    stripeCustomerId: subscription.customer.stripeCustomerId }, deps.prisma, deps.stripe);
  if (lines.some((line) => line.serviceId !== subscription.serviceId ||
    line.billingMonth !== source.billingMonth) ||
    lines.reduce((sum, line) => sum + line.subscriptionMinor, 0n) !== source.amountMinor) {
    throw new AppError('INTERNAL', 409, 'STRIPE_CANCELED_RENEWAL_LINES_UNPROVEN');
  }
  if (invoice.status === 'paid' || invoice.auto_advance === true) return;
  const usage = lines.reduce((sum, line) => sum + line.usageMinor, 0n);
  const proof = await (deps.quoteUsage ?? quoteUnexportedClosedPeriodLiability)({
    subscriptionId: subscription.id, billingMonth: source.billingMonth,
    invoicedUsageAmountMinor: usage,
  }, { prisma: deps.prisma });
  if (proof.currency !== source.currency || proof.amountMicroMinor !== 0n) {
    throw new AppError('INTERNAL', 409, 'STRIPE_CANCELED_RENEWAL_USAGE_UNRESOLVED');
  }
  const resumed = invoice.status === 'draft' ?
    await deps.stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: true }) :
    await deps.stripe.invoices.update(invoice.id, { auto_advance: true });
  assertStripeObjectLivemode(resumed, subscription.livemode);
  if (resumed.id !== invoice.id || resumed.auto_advance !== true ||
    stripeExternalId(resumed.customer) !== subscription.customer.stripeCustomerId ||
    resumed.currency !== invoice.currency) {
    throw new AppError('INTERNAL', 409, 'STRIPE_CANCELED_RENEWAL_RESUME_UNCONFIRMED');
  }
}
