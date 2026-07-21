import type { Prisma, PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import {
  assertStripeObjectLivemode,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import {
  retrieveStripeSubscription,
  stripeExternalId,
} from './billing-stripe-webhook-utils.service.js';

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
  const candidate = value as { discount?: unknown; discounts?: unknown };
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

export async function syncBaseStripeSubscription(
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
      tariff: { include: { stripePrices: { include: { catalog: true } } } },
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
    await tx.billingStripeSubscription.update({ where: { id: existing.id }, data: mutable });
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

export async function terminalizeMissingBaseStripeSubscription(
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
  params: { subscriptionId: string; account: StripeAccountContext },
  deps: { prisma: PrismaClient; stripe: Pick<Stripe, 'subscriptions'> },
): Promise<Stripe.Subscription | null> {
  const subscription = await retrieveStripeSubscription(deps.stripe, params.subscriptionId);
  if (subscription) {
    await syncStripeSubscriptionProjection(
      { subscription, account: params.account },
      { prisma: deps.prisma },
    );
  } else {
    await deps.prisma.$transaction((tx) =>
      terminalizeMissingBaseStripeSubscription(tx, params.account, params.subscriptionId),
    );
  }
  return subscription;
}

export async function syncStripeSubscriptionProjection(
  params: { subscription: Stripe.Subscription; account: StripeAccountContext },
  deps: { prisma: PrismaClient },
): Promise<void> {
  await deps.prisma.$transaction((tx) =>
    syncBaseStripeSubscription(tx, params.subscription, params.account),
  );
}
