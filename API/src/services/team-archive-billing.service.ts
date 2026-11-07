import type { PrismaClient, TeamArchiveOperation } from '@prisma/client';
import type Stripe from 'stripe';
import { AppError } from '../utils/errors.js';
import { assertStripeObjectLivemode, requireStripeWebhookConfigured,
  resolveStripeAccountContext } from './billing-stripe-client.service.js';
import { observedBillingTime } from './billing-seat-observed-time.service.js';

export type ArchiveStripe = Pick<Stripe, 'accounts' | 'subscriptions' | 'checkout' | 'invoices' | 'paymentIntents'>;
const externalId = (value: string | { id: string } | null): string | null =>
  typeof value === 'string' ? value : value?.id ?? null;

/** Re-read provider state on every retry. Customer ownership comes from UOA's
 * exact TEAM scope, never a product-supplied Stripe identifier or metadata.
 * Shared organisation customers and historical payments remain untouched.
 */
export async function stopArchivedTeamBilling(operation: TeamArchiveOperation, deps: {
  prisma: PrismaClient; stripe?: ArchiveStripe; livemode?: boolean; now?: () => Date;
}): Promise<boolean> {
  const customers = await deps.prisma.billingStripeCustomer.findMany({ where: {
    orgId: operation.orgId, teamId: operation.teamId, scope: 'TEAM',
  }, include: { account: true } });
  const now = deps.now?.() ?? await observedBillingTime(deps.prisma);
  const remoteCustomers = customers.filter(customer => customer.stripeCustomerId);
  if (!remoteCustomers.length) return operation.settleAfter <= now;
  const configured = deps.stripe ? { client: deps.stripe, livemode: deps.livemode ?? false }
    : requireStripeWebhookConfigured();
  const stripe = configured.client;
  const livemode = configured.livemode;
  const account = await resolveStripeAccountContext(stripe, livemode, deps.prisma);
  for (const customer of remoteCustomers) {
    if (customer.accountId !== account.id || customer.account.livemode !== livemode ||
      customer.scopeKey !== `${operation.orgId}:${operation.teamId}`) {
      throw new AppError('SERVICE_UNAVAILABLE', 503, 'ARCHIVE_BILLING_ACCOUNT_UNAVAILABLE');
    }
    const id = customer.stripeCustomerId;
    if (!id) continue;
    for await (const session of stripe.checkout.sessions.list({ customer: id, status: 'open', limit: 100 })) {
      assertStripeObjectLivemode(session, livemode);
      if (externalId(session.customer) !== id) throw new Error('ARCHIVE_CHECKOUT_SCOPE_MISMATCH');
      try { await stripe.checkout.sessions.expire(session.id); }
      catch (error) {
        const current = await stripe.checkout.sessions.retrieve(session.id);
        if (current.status === 'open') throw error;
      }
    }
    for await (const subscription of stripe.subscriptions.list({ customer: id, status: 'all', limit: 100 })) {
      assertStripeObjectLivemode(subscription, livemode);
      if (externalId(subscription.customer) !== id) throw new Error('ARCHIVE_SUBSCRIPTION_SCOPE_MISMATCH');
      if (['canceled', 'incomplete_expired'].includes(subscription.status)) continue;
      try {
        const stopped = await stripe.subscriptions.cancel(subscription.id, { invoice_now: false, prorate: false });
        if (stopped.status !== 'canceled') return false;
      } catch (error) {
        const current = await stripe.subscriptions.retrieve(subscription.id);
        if (!['canceled', 'incomplete_expired'].includes(current.status)) throw error;
      }
    }
    for (const status of ['draft', 'open'] as const) {
      for await (const invoice of stripe.invoices.list({ customer: id, status, limit: 100 })) {
        assertStripeObjectLivemode(invoice, livemode);
        if (externalId(invoice.customer) !== id) throw new Error('ARCHIVE_INVOICE_SCOPE_MISMATCH');
        if (invoice.auto_advance) await stripe.invoices.update(invoice.id, { auto_advance: false });
      }
    }
    for await (const payment of stripe.paymentIntents.list({ customer: id, limit: 100 })) {
      assertStripeObjectLivemode(payment, livemode);
      if (externalId(payment.customer) !== id) throw new Error('ARCHIVE_PAYMENT_SCOPE_MISMATCH');
      if (['succeeded', 'canceled'].includes(payment.status)) continue;
      try {
        const stopped = await stripe.paymentIntents.cancel(payment.id);
        if (stopped.status !== 'canceled' && stopped.status !== 'succeeded') return false;
      } catch (error) {
        const current = await stripe.paymentIntents.retrieve(payment.id);
        if (!['canceled', 'succeeded'].includes(current.status)) throw error;
      }
    }
  }
  return operation.settleAfter <= now;
}
