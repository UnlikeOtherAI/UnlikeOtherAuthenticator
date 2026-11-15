import type { Prisma, PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { weekdayGraceDeadline } from './billing-commercial-clock.service.js';
import type { StripeAccountContext } from './billing-stripe-client.service.js';
import { verifyStripePaymentInvoiceLines } from './billing-stripe-payment-lines.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

type Provider = Pick<Stripe, 'invoices' | 'events'>;
type RenewalFailure = { accountId: string; subscriptionId: string; stripeInvoiceId: string;
  failedAt: Date; graceEndsAt: Date; reason: 'payment_required' | 'payment_action_required' };

/** One bounded page per delivery; retries continue the retained probe instead of restarting it. */
export async function firstSeatRenewalFailure(invoice: Stripe.Invoice, event: Stripe.Event,
  accountId: string, prisma: PrismaClient, stripe: Pick<Stripe, 'events'>): Promise<Date> {
  const key = { accountId_stripeInvoiceId: { accountId, stripeInvoiceId: invoice.id } };
  const existing = await prisma.billingSeatRenewalRecovery.findUnique({ where: key });
  if (existing) return existing.failedAt;
  if (invoice.created * 1000 < Date.now() - 30 * 86400_000) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_FAILURE_HISTORY_EXPIRED');
  }
  const probe = await prisma.billingSeatFailureHistory.upsert({ where: key,
    create: { ...key.accountId_stripeInvoiceId, earliestFailureAt: new Date(event.created * 1000) }, update: {} });
  if (probe.complete) return probe.earliestFailureAt;
  const page = await stripe.events.list({ types: ['invoice.payment_failed', 'invoice.payment_action_required'],
    limit: 100, created: { gte: invoice.created }, ...(probe.cursor ? { starting_after: probe.cursor } : {}) });
  let earliest = probe.earliestFailureAt.getTime();
  for (const candidate of page.data) {
    const source = candidate.data.object as Stripe.Invoice;
    if (candidate.livemode === event.livemode && source.id === invoice.id) earliest = Math.min(earliest, candidate.created * 1000);
  }
  const cursor = page.data.at(-1)?.id ?? probe.cursor;
  if (page.has_more && cursor === probe.cursor) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_FAILURE_HISTORY_UNRESOLVED');
  await prisma.billingSeatFailureHistory.updateMany({ where: { ...key.accountId_stripeInvoiceId, generation: probe.generation },
    data: { cursor, earliestFailureAt: new Date(earliest), complete: !page.has_more, generation: { increment: 1 } } });
  const current = await prisma.billingSeatFailureHistory.findUniqueOrThrow({ where: key });
  if (!current.complete) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_FAILURE_HISTORY_CONTINUING');
  return current.earliestFailureAt;
}

export async function prepareSeatRenewalFailure(event: Stripe.Event, account: StripeAccountContext,
  prisma: PrismaClient, stripe: Provider): Promise<RenewalFailure | null> {
  if (event.type !== 'invoice.payment_failed' && event.type !== 'invoice.payment_action_required') return null;
  const signed = event.data.object as Stripe.Invoice;
  const invoice = await stripe.invoices.retrieve(signed.id);
  if (invoice.id !== signed.id || invoice.livemode !== account.livemode ||
    stripeExternalId(invoice.customer) !== stripeExternalId(signed.customer)) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_RENEWAL_SOURCE_DRIFT');
  }
  if (invoice.billing_reason !== 'subscription_cycle' || invoice.status !== 'open' || invoice.amount_remaining <= 0) return null;
  const externalSubscription = stripeExternalId(invoice.parent?.subscription_details?.subscription);
  if (!externalSubscription) return null;
  const subscription = await prisma.billingStripeSubscription.findUnique({
    where: { accountId_stripeSubscriptionId: { accountId: account.id, stripeSubscriptionId: externalSubscription } },
    include: { tariff: true, customer: true, service: true },
  });
  if (!subscription || subscription.service.identifier !== 'nessie' || !subscription.tariff.anniversarySeats ||
    !subscription.initialSeatInvoiceId) return null;
  if (subscription.livemode !== account.livemode || !subscription.customer.stripeCustomerId ||
    subscription.customer.stripeCustomerId !== stripeExternalId(invoice.customer)) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_RENEWAL_SOURCE_DRIFT');
  }
  const lines = await verifyStripePaymentInvoiceLines({ invoice, accountId: account.id, subscriptionId: subscription.id,
    orgId: subscription.orgId, stripeCustomerId: subscription.customer.stripeCustomerId }, prisma, stripe);
  if (!lines.some(line => line.serviceId === subscription.serviceId && line.subscriptionMinor > 0n)) return null;
  const failedAt = await firstSeatRenewalFailure(invoice, event, account.id, prisma, stripe);
  return { accountId: account.id, subscriptionId: subscription.id, stripeInvoiceId: invoice.id, failedAt,
    graceEndsAt: weekdayGraceDeadline(failedAt, 'UTC'),
    reason: event.type === 'invoice.payment_action_required' ? 'payment_action_required' : 'payment_required' };
}

export async function recordSeatRenewalFailure(tx: Prisma.TransactionClient, failure: RenewalFailure): Promise<void> {
  await tx.$queryRaw`SELECT id FROM billing_stripe_subscriptions WHERE id=${failure.subscriptionId} FOR UPDATE`;
  // A delayed failure cannot undo an already verified payment receipt.
  const paid = await tx.billingSeatPaymentPeriod.findFirst({ where: { subscriptionId: failure.subscriptionId,
    invoice: { accountId: failure.accountId, stripeInvoiceId: failure.stripeInvoiceId } }, select: { id: true } });
  if (paid) return;
  await tx.billingSeatRenewalRecovery.upsert({ where: {
    accountId_stripeInvoiceId: { accountId: failure.accountId, stripeInvoiceId: failure.stripeInvoiceId },
  }, create: failure, update: {} });
}
