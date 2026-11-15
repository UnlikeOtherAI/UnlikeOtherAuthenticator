import type Stripe from 'stripe';

import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

type Provider = Pick<Stripe, 'subscriptions' | 'invoices' | 'events'>;
export type SeatPayment = {
  id: bigint;
  delta: number;
  fromQuantity: number;
  toQuantity: number;
  effectiveAt: Date;
  firstAttemptAt: Date;
  attemptVersion: number;
  stripeInvoiceId: string | null;
  account: string;
  livemode: boolean;
  checkoutId: string;
  customerId: string;
  subscriptionId: string;
  itemId: string;
  priceId: string;
  currency: string;
  unitAmount: bigint;
};

type Decision =
  | { status: 'complete'; invoice: string | null }
  | { status: 'pending'; invoice: string; reason: string }
  | { status: 'retry-void' }
  | { status: 'hold'; reason: string };

function boundItem(subscription: Stripe.Subscription, change: SeatPayment) {
  if (subscription.id !== change.subscriptionId || subscription.livemode !== change.livemode ||
    stripeExternalId(subscription.customer) !== change.customerId ||
    subscription.metadata.uoa_checkout_id !== change.checkoutId ||
    subscription.metadata.uoa_stripe_account_id !== change.account ||
    subscription.billing_mode?.type !== 'classic') return undefined;
  const item = subscription.items.data.find(candidate => candidate.id === change.itemId);
  if (!item || item.price.id !== change.priceId || item.price.currency !== change.currency.toLowerCase() ||
    item.price.unit_amount?.toString() !== change.unitAmount.toString() ||
    item.price.recurring?.interval !== 'month' || item.price.recurring.interval_count !== 1 ||
    item.price.recurring.usage_type !== 'licensed') return undefined;
  return item;
}

function paidInvoice(invoice: Stripe.Invoice, change: SeatPayment, subscription: Stripe.Subscription): Decision {
  if (invoice.livemode !== change.livemode || stripeExternalId(invoice.customer) !== change.customerId ||
    stripeExternalId(invoice.parent?.subscription_details?.subscription) !== change.subscriptionId ||
    invoice.billing_reason !== 'subscription_update' || invoice.currency !== change.currency.toLowerCase()) {
    return { status: 'hold', reason: 'INVOICE_BINDING' };
  }
  const quantity = boundItem(subscription, change)?.quantity;
  if (invoice.status === 'paid' && quantity === change.toQuantity && !subscription.pending_update) {
    return { status: 'complete', invoice: invoice.id };
  }
  if (invoice.status === 'void' && !subscription.pending_update && quantity === change.fromQuantity) {
    return { status: 'retry-void' };
  }
  return { status: 'pending', invoice: invoice.id, reason: invoice.status === 'paid' ? 'QUANTITY_PENDING' : 'PAYMENT_REQUIRED' };
}

/** The subscription quantity change and its prorated invoice are one Stripe operation. */
export async function collectAnniversarySeat(change: SeatPayment, stripe: Provider, now: Date): Promise<Decision> {
  const subscription = await stripe.subscriptions.retrieve(change.subscriptionId);
  const item = boundItem(subscription, change);
  if (!item) return { status: 'hold', reason: 'SUBSCRIPTION_BINDING' };
  if (change.stripeInvoiceId) {
    return paidInvoice(await stripe.invoices.retrieve(change.stripeInvoiceId), change, subscription);
  }
  const canReduce = change.delta < 0 && ['past_due', 'unpaid'].includes(subscription.status);
  if (subscription.status !== 'active' && !canReduce) return { status: 'hold', reason: 'SUBSCRIPTION_PAYMENT_REQUIRED' };

  if (item.quantity !== change.fromQuantity && item.quantity !== change.toQuantity) {
    return { status: 'hold', reason: 'QUANTITY_MISMATCH' };
  }
  const key = ['uoa', change.account, change.livemode ? 'live' : 'test', change.checkoutId,
    'seat', change.id, change.attemptVersion].join(':');
  if (item.quantity === change.toQuantity) {
    // A matching quantity alone could come from an operator editing Stripe. Recover the event
    // for this exact write before recognising payment or issuing another update.
    for await (const event of stripe.events.list({ type: 'customer.subscription.updated',
      created: { gte: Math.floor(change.firstAttemptAt.getTime() / 1000) - 60,
        lte: Math.floor(change.firstAttemptAt.getTime() / 1000) + 24 * 3600 }, limit: 100 })) {
      const applied = event.data.object as Stripe.Subscription;
      if (event.request?.idempotency_key !== key || applied.id !== subscription.id) continue;
      if (change.delta < 0) return { status: 'complete', invoice: null };
      const invoice = stripeExternalId(applied.latest_invoice);
      if (invoice) return paidInvoice(await stripe.invoices.retrieve(invoice), change, subscription);
    }
    return { status: 'hold', reason: 'PAYMENT_RECONCILIATION_REQUIRED' };
  }
  // A read can recover a known write across an anniversary. A new charge needs both the
  // original billing period and a key still inside Stripe's idempotency retention window.
  // An unapplied reduction sets the verified quantity without a charge or credit, so it
  // can safely retry after that window while the ordered queue still owns the transition.
  const at = Math.floor(change.effectiveAt.getTime() / 1000);
  if (change.delta > 0 && (at < item.current_period_start || at >= item.current_period_end)) {
    return { status: 'hold', reason: 'PRORATION_PERIOD_MISMATCH' };
  }
  if (change.delta > 0 && now.getTime() - change.firstAttemptAt.getTime() >= 23 * 3600_000) {
    return { status: 'hold', reason: 'PAYMENT_RECONCILIATION_REQUIRED' };
  }
  const updated = await stripe.subscriptions.update(subscription.id, {
    items: [{ id: item.id, quantity: change.toQuantity }],
    ...(change.delta > 0
      ? { proration_behavior: 'always_invoice', payment_behavior: 'pending_if_incomplete', proration_date: at }
      : { proration_behavior: 'none' }),
    expand: ['latest_invoice'],
  }, { idempotencyKey: key });
  const next = boundItem(updated, change);
  if (!next) return { status: 'hold', reason: 'SUBSCRIPTION_BINDING' };
  if (change.delta < 0) return next.quantity === change.toQuantity && !updated.pending_update
    ? { status: 'complete', invoice: null } : { status: 'hold', reason: 'QUANTITY_MISMATCH' };
  if (!updated.latest_invoice || typeof updated.latest_invoice === 'string') {
    return { status: 'hold', reason: 'INVOICE_BINDING' };
  }
  return paidInvoice(updated.latest_invoice, change, updated);
}
