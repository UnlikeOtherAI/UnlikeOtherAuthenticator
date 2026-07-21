import type { BillingRecurringAddonCatalog, BillingRecurringAddonCheckout } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import type { StripeAccountContext } from './billing-stripe-client.service.js';

export const RECURRING_ADDON_BINDING_KIND = 'recurring_addon' as const;

type CheckoutBinding = Pick<
  BillingRecurringAddonCheckout,
  | 'id'
  | 'serviceId'
  | 'offerId'
  | 'offerKey'
  | 'orgId'
  | 'teamId'
  | 'requestedTeamId'
  | 'subscribingUserId'
  | 'scope'
  | 'scopeKey'
>;

export function recurringAddonMetadata(
  checkout: CheckoutBinding,
  account: StripeAccountContext,
): Stripe.MetadataParam {
  return {
    uoa_binding_kind: RECURRING_ADDON_BINDING_KIND,
    uoa_recurring_addon_checkout_id: checkout.id,
    uoa_service_id: checkout.serviceId,
    uoa_offer_id: checkout.offerId,
    uoa_offer_key: checkout.offerKey,
    uoa_organisation_id: checkout.orgId,
    uoa_requested_team_id: checkout.requestedTeamId,
    uoa_scope: checkout.scope.toLowerCase(),
    uoa_scope_key: checkout.scopeKey,
    uoa_stripe_account_id: account.stripeAccountId,
    uoa_stripe_mode: account.livemode ? 'live' : 'test',
    ...(checkout.teamId ? { uoa_team_id: checkout.teamId } : {}),
    ...(checkout.subscribingUserId ? { uoa_subscribing_user_id: checkout.subscribingUserId } : {}),
  };
}

export function hasRecurringAddonMarker(metadata: Stripe.Metadata | null | undefined): boolean {
  return metadata?.uoa_binding_kind === RECURRING_ADDON_BINDING_KIND;
}

function uoaFingerprint(metadata: Stripe.Metadata | null | undefined): string {
  return Object.entries(metadata ?? {})
    .filter(([key]) => key.startsWith('uoa_'))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}\0${value}`)
    .join('\0');
}

export function assertSameUoaBindingMetadata(
  signed: Stripe.Metadata | null | undefined,
  current: Stripe.Metadata | null | undefined,
): void {
  if (uoaFingerprint(signed) !== uoaFingerprint(current)) {
    throw new AppError('INTERNAL', 503, 'STRIPE_WEBHOOK_BINDING_STATE_DRIFT');
  }
}

export function assertRecurringAddonMetadata(
  metadata: Stripe.Metadata | null | undefined,
  checkout: CheckoutBinding,
  account: StripeAccountContext,
): void {
  const expected = recurringAddonMetadata(checkout, account);
  const actual = metadata ?? {};
  if (
    Object.keys(actual).filter((key) => key.startsWith('uoa_')).length !==
      Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => actual[key] !== value)
  ) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_BINDING_DRIFT');
  }
}

export function exactRecurringAddonItem(
  subscription: Stripe.Subscription,
  catalog: Pick<BillingRecurringAddonCatalog, 'stripePriceId'>,
): Stripe.SubscriptionItem {
  const item = subscription.items.data[0];
  if (
    subscription.items.data.length !== 1 ||
    !item ||
    !catalog.stripePriceId ||
    item.price.id !== catalog.stripePriceId ||
    item.quantity !== 1 ||
    item.price.recurring?.interval !== 'month' ||
    item.price.recurring.usage_type !== 'licensed' ||
    Boolean((subscription as { discount?: unknown }).discount) ||
    subscription.discounts.length > 0 ||
    item.discounts.length > 0
  ) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_ITEMS_DRIFT');
  }
  return item;
}

export function recurringAddonPeriod(subscription: Stripe.Subscription): {
  start: Date | null;
  end: Date | null;
} {
  const item = subscription.items.data[0];
  return {
    start:
      typeof item?.current_period_start === 'number'
        ? new Date(item.current_period_start * 1000)
        : null,
    end:
      typeof item?.current_period_end === 'number'
        ? new Date(item.current_period_end * 1000)
        : null,
  };
}
