import {
  BillingCollectionMode,
  BillingTariffMode,
  BillingTariffSource,
  Prisma,
} from '@prisma/client';

import { AppError } from '../utils/errors.js';
import type { LedgerBillingUsage } from './billing-ledger-collector.service.js';
import { billingModeToPublic } from './billing-tariff-serialization.service.js';

const STRIPE_ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);
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

function currencyMinorDigits(currency: string): number {
  return STRIPE_ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
}

/**
 * Converts Ledger's exact major-currency decimal into the integer quantity used
 * by Stripe's 0.000001-minor-unit meter price. Extra precision is rounded
 * half-up only at that final Stripe representability boundary.
 */
export function stripeMeterQuantityFromMajorAmount(amount: string, currency: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(amount) || !/^[A-Z]{3}$/.test(currency)) {
    throw new AppError('INTERNAL', 502, 'LEDGER_BILLING_AMOUNT_INVALID');
  }
  const [whole, fraction = ''] = amount.split('.');
  const scaleDigits = currencyMinorDigits(currency) + STRIPE_METER_FRACTION_DIGITS;
  const keptFraction = fraction.slice(0, scaleDigits).padEnd(scaleDigits, '0');
  const combined = `${whole}${keptFraction}`.replace(/^0+(?=\d)/, '');
  let quantity = BigInt(combined || '0');
  const roundingDigit = fraction.at(scaleDigits);
  if (roundingDigit && roundingDigit >= '5') {
    quantity += 1n;
  }
  if (quantity > MAX_SIGNED_BIGINT) {
    throw new AppError('INTERNAL', 502, 'LEDGER_BILLING_AMOUNT_OUT_OF_RANGE');
  }
  return quantity;
}

export function stripeUsageMonthBounds(billingMonth: string): { startsAt: Date; endsAt: Date } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(billingMonth);
  if (!match) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_MONTH_INVALID');
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const startsAt = new Date(Date.UTC(year, monthIndex, 1));
  const endsAt = new Date(Date.UTC(year, monthIndex + 1, 1));
  return { startsAt, endsAt };
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
  usage: LedgerBillingUsage,
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
    usage.scope.organizationId !== subscription.orgId ||
    usage.scope.teamId !== subscription.teamId ||
    usage.scope.userId !== null ||
    usage.scope.month !== billingMonth ||
    usage.scope.startsAt !== bounds.startsAt.toISOString() ||
    usage.scope.endsAt !== bounds.endsAt.toISOString() ||
    (!invoicePeriod ? !periodMatchesSubscription : !periodMatchesJustEndedInvoice)
  ) {
    throw new AppError('INTERNAL', 502, 'LEDGER_BILLING_SCOPE_MISMATCH');
  }
}

function expectedAssignmentScope(
  source: BillingTariffSource,
): LedgerBillingUsage['monthlyComponents'][number]['assignmentScope'] {
  const scopes = {
    [BillingTariffSource.SERVICE_DEFAULT]: 'service_default',
    [BillingTariffSource.ORGANISATION]: 'organisation',
    [BillingTariffSource.TEAM]: 'team',
  } as const;
  return scopes[source];
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

function assertMonthlyComponent(
  component: LedgerBillingUsage['monthlyComponents'][number],
  subscription: StripeUsageSubscription,
): void {
  const expectedMultiplier = 10_000 + subscription.tariff.markupBps;
  const assignmentScope = expectedAssignmentScope(subscription.tariffSource);
  if (
    component.billingProduct !== subscription.service.identifier ||
    component.tariffId !== subscription.tariff.id ||
    component.tariffKey !== subscription.tariff.key ||
    component.tariffVersion !== subscription.tariff.version ||
    component.tariffMode !== billingModeToPublic(subscription.tariff.mode) ||
    component.markupBps !== subscription.tariff.markupBps ||
    component.usageMultiplierBps !== expectedMultiplier ||
    component.assignmentScope !== assignmentScope ||
    component.assignmentId !== subscription.tariffAssignmentId ||
    component.amountMinor !== subscription.tariff.monthlyAmountMinor.toString() ||
    component.currency !== subscription.tariff.currency ||
    !component.usageBillingEnabled ||
    component.collectionMode !== 'stripe' ||
    !component.paymentCollectionEnabled
  ) {
    throw new AppError('INTERNAL', 502, 'LEDGER_BILLING_TARIFF_MISMATCH');
  }
}

export function stripeUsageChargeKey(callerProduct: string, currency: string): string {
  return `${callerProduct}\0${currency}`;
}

export function validatedStripeCumulativeCharges(
  usage: LedgerBillingUsage,
  subscription: StripeUsageSubscription,
): Map<string, CumulativeCharge> {
  const componentsByKey = new Map<string, number>();
  for (const component of usage.monthlyComponents) {
    assertMonthlyComponent(component, subscription);
    const key = stripeUsageChargeKey(component.callerProduct, component.currency);
    componentsByKey.set(key, (componentsByKey.get(key) ?? 0) + 1);
  }
  if ([...componentsByKey.values()].some((count) => count !== 1)) {
    throw new AppError('INTERNAL', 502, 'LEDGER_BILLING_COMPONENT_MISMATCH');
  }

  const charges = new Map<string, CumulativeCharge>();
  for (const charge of usage.totals.customerCharges) {
    if (
      charge.billingProduct !== subscription.service.identifier ||
      charge.currency !== subscription.tariff.currency
    ) {
      throw new AppError('INTERNAL', 502, 'LEDGER_BILLING_CHARGE_MISMATCH');
    }
    const key = stripeUsageChargeKey(charge.callerProduct, charge.currency);
    if (charges.has(key) || !componentsByKey.has(key)) {
      throw new AppError('INTERNAL', 502, 'LEDGER_BILLING_CHARGE_MISMATCH');
    }
    charges.set(key, {
      ...charge,
      quantity: stripeMeterQuantityFromMajorAmount(charge.amount, charge.currency),
    });
  }

  for (const component of usage.monthlyComponents) {
    const key = stripeUsageChargeKey(component.callerProduct, component.currency);
    charges.set(
      key,
      charges.get(key) ?? {
        billingProduct: component.billingProduct,
        callerProduct: component.callerProduct,
        currency: component.currency,
        amount: '0',
        quantity: 0n,
      },
    );
  }
  return charges;
}
