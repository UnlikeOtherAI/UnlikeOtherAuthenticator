import { type Prisma, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import {
  assertStripeObjectLivemode,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import {
  assertRecurringAddonMetadata,
  assertSameUoaBindingMetadata,
  exactRecurringAddonItem,
  hasRecurringAddonMarker,
} from './billing-recurring-addon-stripe-binding.service.js';
import { recurringAddonSubscriptionInclude } from './billing-recurring-addon-subscription.service.js';
import {
  retrieveStripeSubscription,
  stripeExternalId,
} from './billing-stripe-webhook-utils.service.js';

export type RecurringAddonWebhookClient = Pick<Stripe, 'checkout' | 'invoices' | 'subscriptions'>;

type EventFields = {
  stripeObjectId?: string;
  stripeObjectStatus?: string | null;
  stripeCustomerId?: string | null;
  stripeCheckoutSessionId?: string | null;
  stripeSubscriptionId?: string | null;
  stripeSubscriptionItemId?: string | null;
  stripeInvoiceId?: string | null;
  amountMinor?: bigint | null;
  currency?: string | null;
};

const checkoutInclude = {
  catalog: true,
  customer: true,
} satisfies Prisma.BillingRecurringAddonCheckoutInclude;

type Checkout = Prisma.BillingRecurringAddonCheckoutGetPayload<{
  include: typeof checkoutInclude;
}>;
type Subscription = Prisma.BillingRecurringAddonSubscriptionGetPayload<{
  include: typeof recurringAddonSubscriptionInclude;
}>;

export type PreparedRecurringAddonWebhook =
  | {
      kind: 'checkout_completed';
      checkout: Checkout;
      session: Stripe.Checkout.Session;
      subscription: Stripe.Subscription;
      item: Stripe.SubscriptionItem;
      eventAt: Date;
      eventFields: EventFields;
    }
  | {
      kind: 'checkout_expired';
      checkout: Checkout;
      session: Stripe.Checkout.Session;
      eventFields: EventFields;
    }
  | {
      kind: 'subscription_sync';
      local: Subscription;
      remote: Stripe.Subscription | null;
      eventAt: Date;
      eventFields: EventFields;
    }
  | {
      kind: 'invoice_paid';
      local: Subscription;
      remote: Stripe.Subscription;
      invoice: Stripe.Invoice;
      eventAt: Date;
      eventFields: EventFields;
    }
  | {
      kind: 'invoice_observed';
      local: Subscription;
      remote: Stripe.Subscription;
      invoice: Stripe.Invoice;
      eventAt: Date;
      eventFields: EventFields;
    };

function drift(): never {
  throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_BINDING_STATE_DRIFT');
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  return stripeExternalId(invoice.parent?.subscription_details?.subscription);
}

function invoiceMetadata(invoice: Stripe.Invoice): Stripe.Metadata | null | undefined {
  return invoice.parent?.subscription_details?.metadata;
}

function hasBaseSubscriptionMarker(metadata: Stripe.Metadata | null | undefined): boolean {
  return Boolean(
    !hasRecurringAddonMarker(metadata) &&
    !metadata?.uoa_recurring_addon_checkout_id &&
    (metadata?.uoa_checkout_id || metadata?.uoa_tariff_id),
  );
}

async function checkoutFromSession(
  payload: Stripe.Checkout.Session,
  session: Stripe.Checkout.Session,
  account: StripeAccountContext,
  prisma: PrismaClient,
): Promise<Checkout | null> {
  const localId =
    session.metadata?.uoa_recurring_addon_checkout_id ??
    payload.metadata?.uoa_recurring_addon_checkout_id ??
    session.client_reference_id ??
    payload.client_reference_id;
  const local = localId
    ? await prisma.billingRecurringAddonCheckout.findUnique({
        where: { id: localId },
        include: checkoutInclude,
      })
    : await prisma.billingRecurringAddonCheckout.findFirst({
        where: { accountId: account.id, stripeCheckoutSessionId: session.id },
        include: checkoutInclude,
      });
  const marked =
    hasRecurringAddonMarker(payload.metadata) || hasRecurringAddonMarker(session.metadata);
  if (!local && !marked) return null;
  if (!local || local.accountId !== account.id) drift();
  assertSameUoaBindingMetadata(payload.metadata, session.metadata);
  assertRecurringAddonMetadata(session.metadata, local, account);
  if (
    payload.mode !== session.mode ||
    payload.status !== session.status ||
    payload.payment_status !== session.payment_status ||
    stripeExternalId(payload.customer) !== stripeExternalId(session.customer) ||
    stripeExternalId(payload.subscription) !== stripeExternalId(session.subscription) ||
    session.mode !== 'subscription' ||
    session.client_reference_id !== local.id ||
    stripeExternalId(session.customer) !== local.customer.stripeCustomerId ||
    (local.stripeCheckoutSessionId && local.stripeCheckoutSessionId !== session.id)
  ) {
    drift();
  }
  return local;
}

function assertSubscriptionForCheckout(
  subscription: Stripe.Subscription,
  checkout: Checkout,
  account: StripeAccountContext,
): Stripe.SubscriptionItem {
  assertStripeObjectLivemode(subscription, account.livemode);
  assertRecurringAddonMetadata(subscription.metadata, checkout, account);
  const item = exactRecurringAddonItem(subscription, checkout.catalog);
  if (stripeExternalId(subscription.customer) !== checkout.customer.stripeCustomerId) drift();
  return item;
}

async function prepareCheckout(
  event: Stripe.Event,
  stripe: RecurringAddonWebhookClient,
  account: StripeAccountContext,
  prisma: PrismaClient,
): Promise<PreparedRecurringAddonWebhook | null> {
  if (!['checkout.session.completed', 'checkout.session.expired'].includes(event.type)) return null;
  const payload = event.data.object as Stripe.Checkout.Session;
  if (hasBaseSubscriptionMarker(payload.metadata)) return null;
  const session = await stripe.checkout.sessions.retrieve(payload.id);
  assertStripeObjectLivemode(session, account.livemode);
  const checkout = await checkoutFromSession(payload, session, account, prisma);
  if (!checkout) return null;
  const common = {
    stripeObjectId: session.id,
    stripeObjectStatus: session.status,
    stripeCustomerId: stripeExternalId(session.customer),
    stripeCheckoutSessionId: session.id,
  };
  if (event.type === 'checkout.session.expired') {
    if (session.status !== 'expired') drift();
    return { kind: 'checkout_expired', checkout, session, eventFields: common };
  }
  const subscriptionId = stripeExternalId(session.subscription);
  if (session.status !== 'complete' || !subscriptionId) drift();
  const subscription = await retrieveStripeSubscription(stripe, subscriptionId);
  if (!subscription) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_SUBSCRIPTION_PENDING');
  }
  const item = assertSubscriptionForCheckout(subscription, checkout, account);
  return {
    kind: 'checkout_completed',
    checkout,
    session,
    subscription,
    item,
    eventAt: new Date(event.created * 1000),
    eventFields: {
      ...common,
      stripeSubscriptionId: subscription.id,
      stripeSubscriptionItemId: item.id,
    },
  };
}

async function localSubscription(
  subscriptionId: string,
  account: StripeAccountContext,
  prisma: PrismaClient,
): Promise<Subscription | null> {
  return prisma.billingRecurringAddonSubscription.findUnique({
    where: {
      accountId_stripeSubscriptionId: {
        accountId: account.id,
        stripeSubscriptionId: subscriptionId,
      },
    },
    include: recurringAddonSubscriptionInclude,
  });
}

function assertLocalSubscription(
  local: Subscription,
  remote: Stripe.Subscription,
  account: StripeAccountContext,
): Stripe.SubscriptionItem {
  assertStripeObjectLivemode(remote, account.livemode);
  assertRecurringAddonMetadata(remote.metadata, local.checkout, account);
  const item = exactRecurringAddonItem(remote, local.catalog);
  if (
    local.stripeSubscriptionId !== remote.id ||
    local.stripeItemId !== item.id ||
    local.accountId !== account.id ||
    local.livemode !== account.livemode ||
    stripeExternalId(remote.customer) !== local.customer.stripeCustomerId
  ) {
    drift();
  }
  return item;
}

async function prepareSubscription(
  event: Stripe.Event,
  stripe: RecurringAddonWebhookClient,
  account: StripeAccountContext,
  prisma: PrismaClient,
): Promise<PreparedRecurringAddonWebhook | null> {
  if (!event.type.startsWith('customer.subscription.')) return null;
  const payload = event.data.object as Stripe.Subscription;
  if (hasBaseSubscriptionMarker(payload.metadata)) return null;
  const local = await localSubscription(payload.id, account, prisma);
  const marked = hasRecurringAddonMarker(payload.metadata);
  if (!local && !marked) return null;
  if (!local) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_CHECKOUT_PENDING');
  }
  const remote = await retrieveStripeSubscription(stripe, payload.id);
  if (remote) {
    assertSameUoaBindingMetadata(payload.metadata, remote.metadata);
    assertLocalSubscription(local, remote, account);
    if (
      payload.status !== remote.status ||
      payload.cancel_at_period_end !== remote.cancel_at_period_end ||
      stripeExternalId(payload.customer) !== stripeExternalId(remote.customer)
    ) {
      drift();
    }
  } else if (!hasRecurringAddonMarker(payload.metadata)) {
    drift();
  }
  return {
    kind: 'subscription_sync',
    local,
    remote,
    eventAt: new Date(event.created * 1000),
    eventFields: {
      stripeObjectId: payload.id,
      stripeObjectStatus: remote?.status ?? 'canceled',
      stripeCustomerId: stripeExternalId(remote?.customer ?? payload.customer),
      stripeSubscriptionId: payload.id,
      stripeSubscriptionItemId: local.stripeItemId,
    },
  };
}

const INVOICE_EVENTS = new Set([
  'invoice.created',
  'invoice.finalization_failed',
  'invoice.marked_uncollectible',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.voided',
]);

function assertInitialInvoice(
  invoice: Stripe.Invoice,
  local: Subscription,
  remote: Stripe.Subscription,
): void {
  const line = invoice.lines.data[0];
  const details = line?.parent?.subscription_item_details;
  const expected = Number(local.catalog.monthlyAmountMinor);
  if (
    invoice.status !== 'paid' ||
    invoice.billing_reason !== 'subscription_create' ||
    invoice.collection_method !== 'charge_automatically' ||
    invoice.amount_due !== expected ||
    invoice.amount_paid !== expected ||
    invoice.amount_remaining !== 0 ||
    invoice.subtotal !== expected ||
    invoice.total !== expected ||
    invoice.currency.toUpperCase() !== local.catalog.currency ||
    invoice.starting_balance !== 0 ||
    invoice.amount_shipping !== 0 ||
    invoice.pre_payment_credit_notes_amount !== 0 ||
    invoice.post_payment_credit_notes_amount !== 0 ||
    invoice.discounts.length > 0 ||
    (invoice.total_discount_amounts?.length ?? 0) > 0 ||
    (invoice.total_pretax_credit_amounts?.length ?? 0) > 0 ||
    (invoice.total_taxes?.length ?? 0) > 0 ||
    invoice.default_tax_rates.length > 0 ||
    invoice.lines.has_more ||
    invoice.lines.data.length !== 1 ||
    !line ||
    line.amount !== expected ||
    line.subtotal !== expected ||
    line.currency.toUpperCase() !== local.catalog.currency ||
    line.quantity !== 1 ||
    line.discounts.length > 0 ||
    (line.discount_amounts?.length ?? 0) > 0 ||
    (line.pretax_credit_amounts?.length ?? 0) > 0 ||
    (line.taxes?.length ?? 0) > 0 ||
    line.parent?.type !== 'subscription_item_details' ||
    !details ||
    details.proration ||
    details.subscription !== remote.id ||
    details.subscription_item !== local.stripeItemId ||
    stripeExternalId(line.subscription) !== remote.id ||
    stripeExternalId(line.pricing?.price_details?.price) !== local.catalog.stripePriceId ||
    line.pricing?.unit_amount_decimal?.toString() !== local.catalog.monthlyAmountMinor.toString()
  ) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_INITIAL_INVOICE_INVALID');
  }
}

async function prepareInvoice(
  event: Stripe.Event,
  stripe: RecurringAddonWebhookClient,
  account: StripeAccountContext,
  prisma: PrismaClient,
): Promise<PreparedRecurringAddonWebhook | null> {
  if (!INVOICE_EVENTS.has(event.type)) return null;
  const payload = event.data.object as Stripe.Invoice;
  const payloadSubscriptionId = invoiceSubscriptionId(payload);
  const payloadMarked = hasRecurringAddonMarker(invoiceMetadata(payload));
  const payloadLocal = payloadSubscriptionId
    ? await localSubscription(payloadSubscriptionId, account, prisma)
    : null;
  if (!payloadMarked && !payloadLocal) return null;
  const invoice = await stripe.invoices.retrieve(payload.id, {
    expand: ['lines.data.pricing.price_details.price'],
  });
  assertStripeObjectLivemode(invoice, account.livemode);
  const subscriptionId = invoiceSubscriptionId(invoice);
  const local =
    payloadLocal && payloadLocal.stripeSubscriptionId === subscriptionId
      ? payloadLocal
      : subscriptionId
        ? await localSubscription(subscriptionId, account, prisma)
        : null;
  const marked =
    hasRecurringAddonMarker(invoiceMetadata(payload)) ||
    hasRecurringAddonMarker(invoiceMetadata(invoice));
  if (!local && !marked) return null;
  if (!local || !subscriptionId || payloadSubscriptionId !== subscriptionId) drift();
  assertSameUoaBindingMetadata(invoiceMetadata(payload), invoiceMetadata(invoice));
  assertRecurringAddonMetadata(invoiceMetadata(invoice), local.checkout, account);
  const remote = await retrieveStripeSubscription(stripe, subscriptionId);
  if (!remote) throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_SUBSCRIPTION_MISSING');
  assertLocalSubscription(local, remote, account);
  if (
    payload.status !== invoice.status ||
    payload.amount_due !== invoice.amount_due ||
    payload.amount_paid !== invoice.amount_paid ||
    payload.total !== invoice.total ||
    payload.currency !== invoice.currency ||
    stripeExternalId(payload.customer) !== stripeExternalId(invoice.customer) ||
    stripeExternalId(invoice.customer) !== local.customer.stripeCustomerId
  ) {
    drift();
  }
  const eventAt = new Date(event.created * 1000);
  const eventFields = {
    stripeObjectId: invoice.id,
    stripeObjectStatus: invoice.status,
    stripeCustomerId: stripeExternalId(invoice.customer),
    stripeSubscriptionId: remote.id,
    stripeSubscriptionItemId: local.stripeItemId,
    stripeInvoiceId: invoice.id,
    amountMinor: BigInt(invoice.amount_paid),
    currency: invoice.currency.toUpperCase(),
  };
  if (event.type === 'invoice.paid') {
    assertInitialInvoice(invoice, local, remote);
    return { kind: 'invoice_paid', local, remote, invoice, eventAt, eventFields };
  }
  return { kind: 'invoice_observed', local, remote, invoice, eventAt, eventFields };
}

export async function prepareRecurringAddonWebhook(
  event: Stripe.Event,
  stripe: RecurringAddonWebhookClient,
  account: StripeAccountContext,
  prisma: PrismaClient,
): Promise<PreparedRecurringAddonWebhook | null> {
  return (
    (await prepareCheckout(event, stripe, account, prisma)) ??
    (await prepareSubscription(event, stripe, account, prisma)) ??
    (await prepareInvoice(event, stripe, account, prisma))
  );
}
