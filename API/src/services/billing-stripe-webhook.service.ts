import type { Prisma, PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { requireStripeBillingEnabled } from './billing-stripe-client.service.js';

type StripeWebhookClient = Pick<Stripe, 'subscriptions' | 'webhooks'>;

function externalId(value: string | { id: string } | null): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

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

async function syncSubscription(
  tx: Prisma.TransactionClient,
  subscription: Stripe.Subscription,
): Promise<void> {
  const checkoutId = subscription.metadata.uoa_checkout_id;
  if (!checkoutId) return;

  const checkout = await tx.billingStripeCheckoutSession.findUnique({
    where: { id: checkoutId },
    include: {
      customer: true,
      tariff: { include: { stripePrice: { include: { catalog: true } } } },
    },
  });
  if (!checkout) return;
  const price = checkout?.tariff.stripePrice;
  const catalog = price?.catalog;
  if (
    !price ||
    !catalog?.stripeUsagePriceId ||
    subscription.metadata.uoa_service_id !== checkout.serviceId ||
    subscription.metadata.uoa_tariff_id !== checkout.tariffId ||
    subscription.metadata.uoa_scope_key !== checkout.scopeKey ||
    externalId(subscription.customer) !== checkout.customer.stripeCustomerId
  ) {
    throw new AppError('INTERNAL', 500, 'STRIPE_SUBSCRIPTION_BINDING_INVALID');
  }

  const usageItem = subscription.items.data.find(
    (item) => item.price.id === catalog.stripeUsagePriceId,
  );
  const monthlyItem = price.stripeMonthlyPriceId
    ? subscription.items.data.find((item) => item.price.id === price.stripeMonthlyPriceId)
    : undefined;
  if (!usageItem || (price.stripeMonthlyPriceId && !monthlyItem)) {
    throw new AppError('INTERNAL', 500, 'STRIPE_SUBSCRIPTION_ITEMS_INVALID');
  }
  const period = subscriptionPeriod(subscription);

  await tx.billingStripeSubscription.upsert({
    where: { stripeSubscriptionId: subscription.id },
    create: {
      customerId: checkout.customerId,
      serviceId: checkout.serviceId,
      tariffId: checkout.tariffId,
      orgId: checkout.orgId,
      teamId: checkout.teamId,
      scope: checkout.scope,
      scopeKey: checkout.scopeKey,
      stripeSubscriptionId: subscription.id,
      stripeMonthlyItemId: monthlyItem?.id ?? null,
      stripeUsageItemId: usageItem.id,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
      livemode: subscription.livemode,
    },
    update: {
      stripeMonthlyItemId: monthlyItem?.id ?? null,
      stripeUsageItemId: usageItem.id,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
      livemode: subscription.livemode,
    },
  });
}

async function processEvent(
  tx: Prisma.TransactionClient,
  event: Stripe.Event,
  retrievedSubscription: Stripe.Subscription | null,
): Promise<void> {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const checkoutId = session.metadata?.uoa_checkout_id ?? session.client_reference_id;
    if (checkoutId) {
      await tx.billingStripeCheckoutSession.updateMany({
        where: {
          id: checkoutId,
          stripeCheckoutSessionId: session.id,
        },
        data: { status: 'complete', completedAt: new Date(event.created * 1000) },
      });
    }
    if (retrievedSubscription) await syncSubscription(tx, retrievedSubscription);
    return;
  }

  if (event.type === 'checkout.session.expired') {
    const session = event.data.object as Stripe.Checkout.Session;
    const checkoutId = session.metadata?.uoa_checkout_id ?? session.client_reference_id;
    if (checkoutId) {
      await tx.billingStripeCheckoutSession.updateMany({
        where: {
          id: checkoutId,
          stripeCheckoutSessionId: session.id,
        },
        data: { status: 'expired' },
      });
    }
    return;
  }

  if (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted' ||
    event.type === 'customer.subscription.paused' ||
    event.type === 'customer.subscription.resumed'
  ) {
    await syncSubscription(tx, event.data.object as Stripe.Subscription);
  }
}

async function subscriptionForCheckoutEvent(
  event: Stripe.Event,
  stripe: StripeWebhookClient,
): Promise<Stripe.Subscription | null> {
  if (event.type !== 'checkout.session.completed') return null;
  const session = event.data.object as Stripe.Checkout.Session;
  const subscriptionId = externalId(session.subscription);
  if (!subscriptionId) return null;
  return stripe.subscriptions.retrieve(subscriptionId);
}

export async function handleStripeWebhook(
  params: { rawBody: Buffer; signature: string },
  deps?: {
    prisma?: PrismaClient;
    stripe?: StripeWebhookClient;
    webhookSecret?: string;
  },
): Promise<{ duplicate: boolean }> {
  const configured = deps?.stripe
    ? { client: deps.stripe, webhookSecret: deps.webhookSecret ?? 'test-secret' }
    : requireStripeBillingEnabled();
  const stripe = configured.client as StripeWebhookClient;
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      params.rawBody,
      params.signature,
      deps?.webhookSecret ?? configured.webhookSecret,
    );
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_STRIPE_WEBHOOK_SIGNATURE');
  }

  const prisma = deps?.prisma ?? getAdminPrisma();
  if (await prisma.billingStripeWebhookEvent.findUnique({ where: { id: event.id } })) {
    return { duplicate: true };
  }
  const subscription = await subscriptionForCheckoutEvent(event, stripe);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.billingStripeWebhookEvent.create({
        data: {
          id: event.id,
          type: event.type,
          apiVersion: event.api_version,
          livemode: event.livemode,
          stripeCreatedAt: new Date(event.created * 1000),
        },
      });
      await processEvent(tx, event, subscription);
    });
    return { duplicate: false };
  } catch (error) {
    if (
      (error as { code?: unknown } | null)?.code === 'P2002' &&
      (await prisma.billingStripeWebhookEvent.findUnique({ where: { id: event.id } }))
    ) {
      return { duplicate: true };
    }
    throw error;
  }
}
