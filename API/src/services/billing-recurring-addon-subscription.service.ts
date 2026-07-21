import type { Prisma, PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import {
  assertStripeObjectLivemode,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import {
  assertRecurringAddonMetadata,
  exactRecurringAddonItem,
  recurringAddonPeriod,
} from './billing-recurring-addon-stripe-binding.service.js';
import {
  retrieveStripeSubscription,
  stripeExternalId,
} from './billing-stripe-webhook-utils.service.js';

export const recurringAddonSubscriptionInclude = {
  checkout: true,
  catalog: true,
  customer: true,
  offer: { include: { featurePolicies: true } },
} satisfies Prisma.BillingRecurringAddonSubscriptionInclude;

export type RecurringAddonSubscriptionWithBinding =
  Prisma.BillingRecurringAddonSubscriptionGetPayload<{
    include: typeof recurringAddonSubscriptionInclude;
  }>;

export type RecurringAddonSubscriptionClient = Pick<Stripe, 'subscriptions'>;

export function assertRecurringAddonSubscriptionBinding(
  local: RecurringAddonSubscriptionWithBinding,
  remote: Stripe.Subscription,
  account: StripeAccountContext,
): Stripe.SubscriptionItem {
  assertStripeObjectLivemode(remote, account.livemode);
  assertRecurringAddonMetadata(remote.metadata, local.checkout, account);
  const item = exactRecurringAddonItem(remote, local.catalog);
  if (
    local.accountId !== account.id ||
    local.livemode !== account.livemode ||
    remote.id !== local.stripeSubscriptionId ||
    stripeExternalId(remote.customer) !== local.customer.stripeCustomerId ||
    item.id !== local.stripeItemId
  ) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_SUBSCRIPTION_DRIFT');
  }
  return item;
}

function terminal(status: string): boolean {
  return status === 'canceled' || status === 'incomplete_expired';
}

export async function syncRecurringAddonSubscriptionProjection(
  params: {
    local: RecurringAddonSubscriptionWithBinding;
    remote: Stripe.Subscription;
    account: StripeAccountContext;
    now?: Date;
  },
  deps: { prisma: Pick<PrismaClient, 'billingRecurringAddonSubscription'> },
): Promise<RecurringAddonSubscriptionWithBinding> {
  assertRecurringAddonSubscriptionBinding(params.local, params.remote, params.account);
  if (terminal(params.local.status)) return params.local;
  const period = recurringAddonPeriod(params.remote);
  const deactivatedAt =
    terminal(params.remote.status) &&
    params.local.entitlementActivatedAt &&
    !params.local.entitlementDeactivatedAt
      ? (params.now ?? new Date())
      : params.local.entitlementDeactivatedAt;
  return deps.prisma.billingRecurringAddonSubscription.update({
    where: { id: params.local.id },
    data: {
      status: params.remote.status,
      cancelAtPeriodEnd: params.remote.cancel_at_period_end,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
      entitlementDeactivatedAt: deactivatedAt,
    },
    include: recurringAddonSubscriptionInclude,
  });
}

export async function terminalizeMissingRecurringAddonSubscription(
  params: {
    local: RecurringAddonSubscriptionWithBinding;
    account: StripeAccountContext;
    now?: Date;
  },
  deps: { prisma: Pick<PrismaClient, 'billingRecurringAddonSubscription'> },
): Promise<RecurringAddonSubscriptionWithBinding> {
  if (
    params.local.accountId !== params.account.id ||
    params.local.livemode !== params.account.livemode
  ) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_SUBSCRIPTION_DRIFT');
  }
  if (terminal(params.local.status)) return params.local;
  return deps.prisma.billingRecurringAddonSubscription.update({
    where: { id: params.local.id },
    data: {
      status: 'canceled',
      cancelAtPeriodEnd: true,
      entitlementDeactivatedAt:
        params.local.entitlementActivatedAt && !params.local.entitlementDeactivatedAt
          ? (params.now ?? new Date())
          : params.local.entitlementDeactivatedAt,
    },
    include: recurringAddonSubscriptionInclude,
  });
}

export async function refreshRecurringAddonSubscriptionProjection(
  params: {
    local: RecurringAddonSubscriptionWithBinding;
    account: StripeAccountContext;
    now?: Date;
  },
  deps: {
    prisma: Pick<PrismaClient, 'billingRecurringAddonSubscription'>;
    stripe: RecurringAddonSubscriptionClient;
  },
): Promise<{
  local: RecurringAddonSubscriptionWithBinding;
  remote: Stripe.Subscription | null;
}> {
  const remote = await retrieveStripeSubscription(deps.stripe, params.local.stripeSubscriptionId);
  if (!remote) {
    return {
      remote,
      local: await terminalizeMissingRecurringAddonSubscription(params, deps),
    };
  }
  return {
    remote,
    local: await syncRecurringAddonSubscriptionProjection({ ...params, remote }, deps),
  };
}
