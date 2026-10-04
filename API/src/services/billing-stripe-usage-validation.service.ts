import { BillingCollectionMode, BillingTariffMode, Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import {
  UNATTRIBUTED_BILLING_PRODUCT,
  type NormalizedMeteringUsage,
} from './billing-metering.types.js';
import { currencyMinorDigits } from './billing-money.service.js';
import { rateMeteringByCaller } from './billing-rating.service.js';

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

function majorAmountFromMeterQuantity(quantity: bigint, currency: string): string {
  const scale = currencyMinorDigits(currency) + STRIPE_METER_FRACTION_DIGITS;
  const digits = quantity.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Keep each caller's prior prepaid allocation fixed and fund only new gross usage. */
export function applyCreditOffsetToStripeCharges(
  charges: Map<string, CumulativeCharge>,
  offsetMicroMinor: bigint,
  previous: ReadonlyMap<string, {
    cumulativeGrossMeterQuantity: bigint | null;
    cumulativeMeterQuantity: bigint;
  }>,
): Map<string, CumulativeCharge> {
  if (offsetMicroMinor < 0n) {
    throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_OFFSET_INVALID');
  }
  const entries = [...charges.entries()].sort(([left], [right]) => left.localeCompare(right));
  const gross = entries.reduce((sum, [, charge]) => sum + charge.quantity, 0n);
  if (gross < offsetMicroMinor) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_OFFSET_EXCEEDS_USAGE');
  }
  let frozenOffset = 0n;
  const allocations = entries.map(([key, charge]) => {
    const prior = previous.get(key);
    if (prior && prior.cumulativeGrossMeterQuantity === null) {
      throw new AppError('INTERNAL', 409, 'STRIPE_BUCKET_GROSS_HISTORY_MISSING');
    }
    const priorGross = prior?.cumulativeGrossMeterQuantity ?? 0n;
    const priorNet = prior?.cumulativeMeterQuantity ?? 0n;
    if (priorGross < priorNet || charge.quantity < priorGross) {
      throw new AppError('INTERNAL', 409, 'STRIPE_BUCKET_USAGE_RECONCILIATION_REQUIRED');
    }
    frozenOffset += priorGross - priorNet;
    return { key, charge, priorNet, increment: charge.quantity - priorGross,
      offset: 0n, remainder: 0n };
  });
  const additionalOffset = offsetMicroMinor - frozenOffset;
  const incrementalGross = allocations.reduce((sum, row) => sum + row.increment, 0n);
  if (additionalOffset < 0n || additionalOffset > incrementalGross) {
    throw new AppError('INTERNAL', 409, 'STRIPE_BUCKET_CREDIT_RECONCILIATION_REQUIRED');
  }
  for (const row of allocations) {
    if (incrementalGross === 0n) break;
    const weighted = row.increment * additionalOffset;
    row.offset = weighted / incrementalGross;
    row.remainder = weighted % incrementalGross;
  }
  let unallocated = additionalOffset - allocations.reduce((sum, row) => sum + row.offset, 0n);
  for (const row of [...allocations].sort((left, right) =>
    left.remainder === right.remainder
      ? left.key.localeCompare(right.key)
      : left.remainder > right.remainder ? -1 : 1,
  )) {
    if (unallocated === 0n) break;
    row.offset += 1n;
    unallocated -= 1n;
  }
  return new Map(allocations.map(({ key, charge, priorNet, increment, offset }) => {
    const quantity = priorNet + increment - offset;
    return [key, {
      ...charge,
      amount: majorAmountFromMeterQuantity(quantity, charge.currency),
      quantity,
    }];
  }));
}

export function validatedStripeCumulativeCharges(
  usage: NormalizedMeteringUsage,
  subscription: StripeUsageSubscription,
): Map<string, CumulativeCharge> {
  const charges = new Map<string, CumulativeCharge>();
  const rated = rateMeteringByCaller({
    usage,
    product: subscription.service.identifier,
    currency: subscription.tariff.currency,
    terms: {
      mode: subscription.tariff.mode.toLowerCase() as 'standard' | 'at_cost' | 'custom',
      markupBps: subscription.tariff.markupBps,
    },
    unattributedCaller: UNATTRIBUTED_BILLING_PRODUCT,
  });
  for (const item of rated) {
    const key = stripeUsageChargeKey(item.callerProduct, item.currency);
    const amount = item.total;
    charges.set(key, {
      billingProduct: item.billingProduct,
      callerProduct: item.callerProduct,
      currency: item.currency,
      amount,
      quantity: stripeMeterQuantityFromMajorAmount(amount, item.currency),
    });
  }
  return charges;
}
