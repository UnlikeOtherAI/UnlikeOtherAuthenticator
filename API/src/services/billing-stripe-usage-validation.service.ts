import { BillingCollectionMode, BillingTariffMode, Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import {
  UNATTRIBUTED_BILLING_PRODUCT,
  type NormalizedMeteringUsage,
} from './billing-metering.types.js';
import {
  addBillingDecimals,
  currencyMinorDigits,
  multiplyBillingDecimalByBps,
} from './billing-money.service.js';

const STRIPE_METER_FRACTION_DIGITS = 6;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
export const STRIPE_METERABLE_SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'unpaid',
] as const;
const meterableSubscriptionStatuses = new Set<string>(STRIPE_METERABLE_SUBSCRIPTION_STATUSES);

export const stripeUsageSubscriptionInclude =
  Prisma.validator<Prisma.BillingStripeSubscriptionInclude>()({
    account: true,
    customer: true,
    service: true,
    tariff: {
      include: {
        stripePrices: { include: { catalog: true } },
      },
    },
  });

export type StripeUsageSubscription = Prisma.BillingStripeSubscriptionGetPayload<{
  include: typeof stripeUsageSubscriptionInclude;
}>;

export type CumulativeCharge = {
  billingProduct: string;
  callerProduct: string;
  currency: string;
  amount: string;
  quantity: bigint;
};

/**
 * Converts UOA's exact customer-rated major-currency decimal into the integer
 * quantity used by Stripe's 0.000001-minor-unit meter price. Extra precision is
 * rounded half-up only at that final Stripe representability boundary.
 */
export function stripeMeterQuantityFromMajorAmount(amount: string, currency: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(amount) || !/^[A-Z]{3}$/.test(currency)) {
    throw new AppError('INTERNAL', 502, 'UOA_BILLING_AMOUNT_INVALID');
  }
  const [whole, fraction = ''] = amount.split('.');
  const scaleDigits = currencyMinorDigits(currency) + STRIPE_METER_FRACTION_DIGITS;
  const keptFraction = fraction.slice(0, scaleDigits).padEnd(scaleDigits, '0');
  const combined = `${whole}${keptFraction}`.replace(/^0+(?=\d)/, '');
  let quantity = BigInt(combined || '0');
  const roundingDigit = fraction.at(scaleDigits);
  if (roundingDigit && roundingDigit >= '5') quantity += 1n;
  if (quantity > MAX_SIGNED_BIGINT) {
    throw new AppError('INTERNAL', 502, 'UOA_BILLING_AMOUNT_OUT_OF_RANGE');
  }
  return quantity;
}

export function stripeUsageMonthBounds(billingMonth: string): { startsAt: Date; endsAt: Date } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(billingMonth);
  if (!match) throw new AppError('BAD_REQUEST', 400, 'BILLING_MONTH_INVALID');
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return {
    startsAt: new Date(Date.UTC(year, monthIndex, 1)),
    endsAt: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
}

export function stripeUsageMeterTimestamp(
  capturedAt: Date,
  billingMonth: string,
  now: Date,
): number {
  const bounds = stripeUsageMonthBounds(billingMonth);
  if (
    Number.isNaN(capturedAt.getTime()) ||
    capturedAt < bounds.startsAt ||
    capturedAt.getTime() > now.getTime() + 5 * 60 * 1000
  ) {
    throw new AppError('BAD_REQUEST', 409, 'STRIPE_USAGE_MONTH_OUT_OF_RANGE');
  }
  const lastSecond = Math.floor(bounds.endsAt.getTime() / 1000) - 1;
  const timestamp = Math.min(Math.floor(capturedAt.getTime() / 1000), lastSecond);
  if (timestamp < Math.floor(now.getTime() / 1000) - 35 * 24 * 60 * 60) {
    throw new AppError('BAD_REQUEST', 409, 'STRIPE_USAGE_MONTH_OUT_OF_RANGE');
  }
  return timestamp;
}

export function assertStripeUsageScope(
  usage: NormalizedMeteringUsage,
  subscription: StripeUsageSubscription,
  billingMonth: string,
  invoicePeriod?: { startsAt: Date; endsAt: Date },
): void {
  const bounds = stripeUsageMonthBounds(billingMonth);
  const periodMatchesSubscription =
    subscription.currentPeriodStart?.getTime() === bounds.startsAt.getTime() &&
    subscription.currentPeriodEnd?.getTime() === bounds.endsAt.getTime();
  const advancedPeriodEnd = new Date(
    Date.UTC(bounds.endsAt.getUTCFullYear(), bounds.endsAt.getUTCMonth() + 1, 1),
  );
  const periodMatchesJustEndedInvoice =
    invoicePeriod?.startsAt.getTime() === bounds.startsAt.getTime() &&
    invoicePeriod.endsAt.getTime() === bounds.endsAt.getTime() &&
    (periodMatchesSubscription ||
      (subscription.currentPeriodStart?.getTime() === bounds.endsAt.getTime() &&
        subscription.currentPeriodEnd?.getTime() === advancedPeriodEnd.getTime()));
  if (
    usage.product !== subscription.service.identifier ||
    usage.groupBy !== 'service' ||
    usage.scope.organizationId !== subscription.orgId ||
    usage.scope.teamId !== subscription.teamId ||
    usage.scope.userId !== null ||
    usage.scope.month !== billingMonth ||
    usage.scope.startsAt !== bounds.startsAt.toISOString() ||
    usage.scope.endsAt !== bounds.endsAt.toISOString() ||
    (!invoicePeriod ? !periodMatchesSubscription : !periodMatchesJustEndedInvoice)
  ) {
    throw new AppError('INTERNAL', 502, 'LEDGER_METERING_SCOPE_MISMATCH');
  }
}

export function assertStripeUsageSubscription(
  subscription: StripeUsageSubscription,
  options?: { allowCanceledInvoicePeriod?: boolean },
): void {
  const price = subscription.tariff.stripePrices.find(
    (candidate) => candidate.accountId === subscription.accountId,
  );
  const catalog = price?.catalog;
  if (
    (!meterableSubscriptionStatuses.has(subscription.status) &&
      !(options?.allowCanceledInvoicePeriod && subscription.status === 'canceled')) ||
    !subscription.service.active ||
    subscription.tariff.serviceId !== subscription.serviceId ||
    subscription.tariff.collectionMode !== BillingCollectionMode.STRIPE ||
    subscription.tariff.mode === BillingTariffMode.FREE ||
    !subscription.customer.stripeCustomerId ||
    subscription.account.livemode !== subscription.livemode ||
    subscription.customer.accountId !== subscription.accountId ||
    subscription.customer.orgId !== subscription.orgId ||
    subscription.customer.teamId !== subscription.teamId ||
    subscription.customer.scope !== subscription.scope ||
    subscription.customer.scopeKey !== subscription.scopeKey ||
    !price ||
    price.accountId !== subscription.accountId ||
    price.tariffId !== subscription.tariffId ||
    price.monthlyAmountMinor !== subscription.tariff.monthlyAmountMinor ||
    !catalog ||
    catalog.accountId !== subscription.accountId ||
    catalog.serviceId !== subscription.serviceId ||
    catalog.currency !== subscription.tariff.currency ||
    !catalog.stripeMeterId ||
    !catalog.stripeUsagePriceId
  ) {
    throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_NOT_METERABLE');
  }
}

export function stripeUsageChargeKey(callerProduct: string, currency: string): string {
  return `${callerProduct}\0${currency}`;
}

export function validatedStripeCumulativeCharges(
  usage: NormalizedMeteringUsage,
  subscription: StripeUsageSubscription,
): Map<string, CumulativeCharge> {
  const baseCosts = new Map<
    string,
    { billingProduct: string; callerProduct: string; currency: string; amount: string }
  >();
  for (const line of usage.lines) {
    if (line.billingProduct !== subscription.service.identifier) {
      throw new AppError('INTERNAL', 502, 'LEDGER_METERING_PRODUCT_MISMATCH');
    }
    const amount = line.selectedProviderCost;
    if (amount === null && line.currency === null) continue;
    if (amount === null || line.currency !== subscription.tariff.currency) {
      throw new AppError('INTERNAL', 502, 'LEDGER_METERING_COST_MISMATCH');
    }
    const callerProduct = line.callerProduct ?? UNATTRIBUTED_BILLING_PRODUCT;
    const key = stripeUsageChargeKey(callerProduct, line.currency);
    const current = baseCosts.get(key);
    baseCosts.set(key, {
      billingProduct: line.billingProduct,
      callerProduct,
      currency: line.currency,
      amount: addBillingDecimals(current?.amount ?? '0', amount),
    });
  }

  const charges = new Map<string, CumulativeCharge>();
  const multiplierBps = 10_000 + subscription.tariff.markupBps;
  for (const [key, base] of baseCosts) {
    const amount = multiplyBillingDecimalByBps(base.amount, multiplierBps);
    charges.set(key, {
      ...base,
      amount,
      quantity: stripeMeterQuantityFromMajorAmount(amount, base.currency),
    });
  }
  return charges;
}
