import type { Prisma, PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  assertStripeObjectLivemode,
  requireStripeWebhookConfigured,
  resolveStripeAccountContext,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import {
  applyCreditFundingWebhook,
  prepareCreditFundingWebhook,
  type CreditFundingWebhookClient,
} from './billing-credit-funding-webhook.service.js';
import {
  reconcileStripeCycleInvoiceUsage,
  type StripeInvoiceWebhookType,
} from './billing-stripe-invoice.service.js';
import {
  retrieveStripeSubscription,
  stripeExternalId,
} from './billing-stripe-webhook-utils.service.js';

type StripeWebhookClient = Pick<
  Stripe,
  'accounts' | 'billing' | 'checkout' | 'invoices' | 'subscriptions' | 'webhooks'
> &
  CreditFundingWebhookClient;

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);
const INVOICE_RECONCILIATION_EVENTS = new Set<StripeInvoiceWebhookType>([
  'invoice.created',
  'invoice.finalization_failed',
]);

function subscriptionPeriod(subscription: Stripe.Subscription): {
  start: Date | null;
  end: Date | null;
} {
  const starts = subscription.items.data
    .map((item) => item.current_period_start)
    .filter((value): value is number => typeof value === 'number');
  const ends = subscription.items.data
    .map((item) => item.current_period_end)
    .filter((value): value is number => typeof value === 'number');
  return {
    start: starts.length > 0 ? new Date(Math.min(...starts) * 1000) : null,
    end: ends.length > 0 ? new Date(Math.max(...ends) * 1000) : null,
  };
}

function hasDiscount(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    discount?: unknown;
    discounts?: unknown;
  };
  return (
    Boolean(candidate.discount) ||
    (Array.isArray(candidate.discounts) && candidate.discounts.length > 0)
  );
}

function exactSubscriptionItems(
  subscription: Stripe.Subscription,
  expected: { monthlyPriceId: string | null; usagePriceId: string },
): { monthlyItem: Stripe.SubscriptionItem | null; usageItem: Stripe.SubscriptionItem } {
  if (hasDiscount(subscription) || subscription.items.data.some((item) => hasDiscount(item))) {
    throw new AppError('INTERNAL', 502, 'STRIPE_SUBSCRIPTION_DISCOUNT_INVALID');
  }
  const expectedIds = [
    ...(expected.monthlyPriceId ? [expected.monthlyPriceId] : []),
    expected.usagePriceId,
  ].sort();
  const actualIds = subscription.items.data.map((item) => item.price.id).sort();
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_SUBSCRIPTION_ITEMS_INVALID');
  }
  const usageItem = subscription.items.data.find((item) => item.price.id === expected.usagePriceId);
  const monthlyItem = expected.monthlyPriceId
    ? subscription.items.data.find((item) => item.price.id === expected.monthlyPriceId)
    : null;
  if (
    !usageItem ||
    usageItem.price.recurring?.usage_type !== 'metered' ||
    (expected.monthlyPriceId &&
      (!monthlyItem ||
        monthlyItem.quantity !== 1 ||
        monthlyItem.price.recurring?.usage_type !== 'licensed'))
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_SUBSCRIPTION_ITEMS_INVALID');
  }
  return { monthlyItem: monthlyItem ?? null, usageItem };
}

function assertImmutableSubscription(
  existing: {
    accountId: string;
    checkoutId: string;
    customerId: string;
    serviceId: string;
    tariffId: string;
    tariffSource: string;
    tariffAssignmentId: string | null;
    orgId: string;
    teamId: string | null;
    scope: string;
    scopeKey: string;
    livemode: boolean;
  },
  checkout: {
    accountId: string;
    id: string;
    customerId: string;
    serviceId: string;
    tariffId: string;
    tariffSource: string;
    tariffAssignmentId: string | null;
    orgId: string;
    teamId: string | null;
    scope: string;
    scopeKey: string;
  },
  account: StripeAccountContext,
): void {
  if (
    existing.accountId !== account.id ||
    existing.checkoutId !== checkout.id ||
    existing.customerId !== checkout.customerId ||
    existing.serviceId !== checkout.serviceId ||
    existing.tariffId !== checkout.tariffId ||
    existing.tariffSource !== checkout.tariffSource ||
    existing.tariffAssignmentId !== checkout.tariffAssignmentId ||
    existing.orgId !== checkout.orgId ||
    existing.teamId !== checkout.teamId ||
    existing.scope !== checkout.scope ||
    existing.scopeKey !== checkout.scopeKey ||
    existing.livemode !== account.livemode
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_SUBSCRIPTION_REBIND_FORBIDDEN');
  }
}

async function syncSubscription(
  tx: Prisma.TransactionClient,
  subscription: Stripe.Subscription,
  account: StripeAccountContext,
): Promise<void> {
  assertStripeObjectLivemode(subscription, account.livemode);
  const checkoutId = subscription.metadata.uoa_checkout_id;
  if (!checkoutId) {
    throw new AppError('INTERNAL', 502, 'STRIPE_SUBSCRIPTION_BINDING_INVALID');
  }
  const checkout = await tx.billingStripeCheckoutSession.findUnique({
    where: { id: checkoutId },
    include: {
      customer: true,
      tariff: {
        include: {
          stripePrices: { include: { catalog: true } },
        },
      },
    },
  });
  if (!checkout || checkout.accountId !== account.id) {
    throw new AppError('INTERNAL', 502, 'STRIPE_SUBSCRIPTION_BINDING_INVALID');
  }
  const price = checkout.tariff.stripePrices.find(
    (candidate) => candidate.accountId === account.id,
  );
  const catalog = price?.catalog;
  if (
    !price ||
    !catalog?.stripeUsagePriceId ||
    catalog.accountId !== account.id ||
    subscription.metadata.uoa_service_id !== checkout.serviceId ||
    subscription.metadata.uoa_tariff_id !== checkout.tariffId ||
    subscription.metadata.uoa_scope_key !== checkout.scopeKey ||
    subscription.metadata.uoa_stripe_account_id !== account.stripeAccountId ||
    subscription.metadata.uoa_stripe_mode !== (account.livemode ? 'live' : 'test') ||
    stripeExternalId(subscription.customer) !== checkout.customer.stripeCustomerId
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_SUBSCRIPTION_BINDING_INVALID');
  }
  const items = exactSubscriptionItems(subscription, {
    monthlyPriceId: price.stripeMonthlyPriceId,
    usagePriceId: catalog.stripeUsagePriceId,
  });
  const period = subscriptionPeriod(subscription);
  const existing = await tx.billingStripeSubscription.findUnique({
    where: {
      accountId_stripeSubscriptionId: {
        accountId: account.id,
        stripeSubscriptionId: subscription.id,
      },
    },
  });
  if (existing) assertImmutableSubscription(existing, checkout, account);
  const mutable = {
    stripeMonthlyItemId: items.monthlyItem?.id ?? null,
    stripeUsageItemId: items.usageItem.id,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
  };
  if (existing) {
    await tx.billingStripeSubscription.update({
      where: { id: existing.id },
      data: mutable,
    });
    return;
  }
  await tx.billingStripeSubscription.create({
    data: {
      accountId: account.id,
      checkoutId: checkout.id,
      customerId: checkout.customerId,
      serviceId: checkout.serviceId,
      tariffId: checkout.tariffId,
      tariffSource: checkout.tariffSource,
      tariffAssignmentId: checkout.tariffAssignmentId,
      orgId: checkout.orgId,
      teamId: checkout.teamId,
      scope: checkout.scope,
      scopeKey: checkout.scopeKey,
      stripeSubscriptionId: subscription.id,
      livemode: account.livemode,
      ...mutable,
    },
  });
}

async function terminalizeMissingSubscription(
  tx: Prisma.TransactionClient,
  account: StripeAccountContext,
  subscriptionId: string,
): Promise<void> {
  await tx.billingStripeSubscription.updateMany({
    where: {
      accountId: account.id,
      stripeSubscriptionId: subscriptionId,
      status: { notIn: ['canceled', 'incomplete_expired'] },
    },
    data: { status: 'canceled', cancelAtPeriodEnd: true },
  });
}

export async function refreshStripeSubscriptionProjection(
  params: {
    subscriptionId: string;
    account: StripeAccountContext;
  },
  deps: {
    prisma: PrismaClient;
    stripe: Pick<Stripe, 'subscriptions'>;
  },
): Promise<Stripe.Subscription | null> {
  const subscription = await retrieveStripeSubscription(deps.stripe, params.subscriptionId);
  if (subscription) {
    await syncStripeSubscriptionProjection(
      { subscription, account: params.account },
      { prisma: deps.prisma },
    );
  } else {
    await deps.prisma.$transaction((tx) =>
      terminalizeMissingSubscription(tx, params.account, params.subscriptionId),
    );
  }
  return subscription;
}

export async function syncStripeSubscriptionProjection(
  params: {
    subscription: Stripe.Subscription;
    account: StripeAccountContext;
  },
  deps: {
    prisma: PrismaClient;
  },
): Promise<void> {
  await deps.prisma.$transaction((tx) => syncSubscription(tx, params.subscription, params.account));
}

type CurrentEventState = {
  checkoutSession: Stripe.Checkout.Session | null;
  subscriptionId: string | null;
  subscription: Stripe.Subscription | null;
};

async function currentEventState(
  event: Stripe.Event,
  stripe: StripeWebhookClient,
  account: StripeAccountContext,
): Promise<CurrentEventState> {
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.expired') {
    const payload = event.data.object as Stripe.Checkout.Session;
    const session = await stripe.checkout.sessions.retrieve(payload.id);
    assertStripeObjectLivemode(session, account.livemode);
    if (session.mode !== 'subscription') {
      return { checkoutSession: null, subscriptionId: null, subscription: null };
    }
    const subscriptionId = stripeExternalId(session.subscription);
    return {
      checkoutSession: session,
      subscriptionId,
      subscription: subscriptionId
        ? await retrieveStripeSubscription(stripe, subscriptionId)
        : null,
    };
  }
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const payload = event.data.object as Stripe.Subscription;
    return {
      checkoutSession: null,
      subscriptionId: payload.id,
      subscription: await retrieveStripeSubscription(stripe, payload.id),
    };
  }
  return { checkoutSession: null, subscriptionId: null, subscription: null };
}

async function syncCheckoutSession(
  tx: Prisma.TransactionClient,
  session: Stripe.Checkout.Session,
  account: StripeAccountContext,
): Promise<void> {
  assertStripeObjectLivemode(session, account.livemode);
  const checkoutId = session.metadata?.uoa_checkout_id ?? session.client_reference_id;
  if (!checkoutId) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CHECKOUT_BINDING_INVALID');
  }
  const checkout = await tx.billingStripeCheckoutSession.findUnique({
    where: { id: checkoutId },
    include: { customer: true },
  });
  if (
    !checkout ||
    checkout.accountId !== account.id ||
    (checkout.stripeCheckoutSessionId && checkout.stripeCheckoutSessionId !== session.id) ||
    stripeExternalId(session.customer) !== checkout.customer.stripeCustomerId ||
    session.mode !== 'subscription'
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CHECKOUT_BINDING_INVALID');
  }
  await tx.billingStripeCheckoutSession.update({
    where: { id: checkout.id },
    data: {
      stripeCheckoutSessionId: session.id,
      status: session.status ?? checkout.status,
      expiresAt: new Date(session.expires_at * 1000),
      ...(session.status === 'complete' && !checkout.completedAt
        ? { completedAt: new Date() }
        : {}),
    },
  });
}

async function processEvent(
  tx: Prisma.TransactionClient,
  state: CurrentEventState,
  account: StripeAccountContext,
): Promise<void> {
  if (state.checkoutSession) {
    await syncCheckoutSession(tx, state.checkoutSession, account);
  }
  if (state.subscription) {
    await syncSubscription(tx, state.subscription, account);
  } else if (state.subscriptionId) {
    await terminalizeMissingSubscription(tx, account, state.subscriptionId);
  }
}

export async function handleStripeWebhook(
  params: { rawBody: Buffer; signature: string },
  deps?: {
    prisma?: PrismaClient;
    stripe?: StripeWebhookClient;
    stripeLivemode?: boolean;
    webhookSecret?: string;
    collectionEnabled?: boolean;
    reconcileInvoice?: typeof reconcileStripeCycleInvoiceUsage;
  },
): Promise<{ duplicate: boolean }> {
  const configured = deps?.stripe ? undefined : requireStripeWebhookConfigured();
  const stripe = (deps?.stripe ?? configured?.client) as StripeWebhookClient | undefined;
  const webhookSecret = deps?.webhookSecret ?? configured?.webhookSecret;
  if (!stripe || !webhookSecret) {
    throw new AppError('INTERNAL', 503, 'STRIPE_BILLING_DISABLED');
  }
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(params.rawBody, params.signature, webhookSecret);
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_STRIPE_WEBHOOK_SIGNATURE');
  }

  const prisma = deps?.prisma ?? getAdminPrisma();
  const livemode = deps?.stripeLivemode ?? configured?.livemode ?? false;
  const account = await resolveStripeAccountContext(stripe, livemode, prisma);
  if (
    event.livemode !== account.livemode ||
    (event.account && event.account !== account.stripeAccountId)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'STRIPE_WEBHOOK_ACCOUNT_MISMATCH');
  }
  const eventKey = {
    accountId_stripeEventId: {
      accountId: account.id,
      stripeEventId: event.id,
    },
  };
  if (await prisma.billingStripeWebhookEvent.findUnique({ where: eventKey })) {
    return { duplicate: true };
  }
  const state = await currentEventState(event, stripe, account);
  const creditFunding = await prepareCreditFundingWebhook(event, stripe, account, prisma);
  const collectionEnabled = deps?.collectionEnabled ?? getEnv().STRIPE_BILLING_ENABLED;
  if (
    collectionEnabled &&
    INVOICE_RECONCILIATION_EVENTS.has(event.type as StripeInvoiceWebhookType)
  ) {
    const invoice = event.data.object as Stripe.Invoice;
    if (!invoice.id) {
      throw new AppError('BAD_REQUEST', 400, 'STRIPE_INVOICE_BINDING_INVALID');
    }
    await (deps?.reconcileInvoice ?? reconcileStripeCycleInvoiceUsage)(
      {
        invoiceId: invoice.id,
        eventType: event.type as StripeInvoiceWebhookType,
        account,
      },
      { prisma, stripe },
    );
  }
  try {
    await prisma.$transaction(async (tx) => {
      const webhookEvent = await tx.billingStripeWebhookEvent.create({
        data: {
          accountId: account.id,
          stripeEventId: event.id,
          type: event.type,
          apiVersion: event.api_version,
          livemode: event.livemode,
          stripeCreatedAt: new Date(event.created * 1000),
          ...creditFunding?.eventFields,
        },
      });
      await processEvent(tx, state, account);
      if (creditFunding) {
        await applyCreditFundingWebhook(tx, creditFunding, webhookEvent.id, account);
      }
    });
    return { duplicate: false };
  } catch (error) {
    if (
      (error as { code?: unknown } | null)?.code === 'P2002' &&
      (await prisma.billingStripeWebhookEvent.findUnique({ where: eventKey }))
    ) {
      return { duplicate: true };
    }
    throw error;
  }
}
