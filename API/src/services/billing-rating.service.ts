import { AppError } from '../utils/errors.js';
import type { NormalizedMeteringUsage, RawMeteringLine } from './billing-metering.types.js';
import {
  addBillingDecimals,
  multiplyBillingDecimalByBps,
  subtractBillingDecimals,
} from './billing-money.service.js';

export type BillingRatingMode = 'standard' | 'free' | 'at_cost' | 'custom';

export type RatedMoney = {
  base: string;
  markup: string;
  total: string;
  currency: string;
};

export type RatedCallerTotal = RatedMoney & {
  billingProduct: string;
  callerProduct: string;
};

type RatingTerms = {
  mode: BillingRatingMode;
  markupBps: number;
};

function assertTerms(terms: RatingTerms): void {
  if (
    !Number.isSafeInteger(terms.markupBps) ||
    terms.markupBps < 0 ||
    ((terms.mode === 'free' || terms.mode === 'at_cost') && terms.markupBps !== 0)
  ) {
    throw new AppError('INTERNAL', 500, 'BILLING_RATING_TERMS_INVALID');
  }
}

export function usagePriceMultiplierBps(terms: RatingTerms): number {
  assertTerms(terms);
  return terms.mode === 'free' ? 0 : 10_000 + terms.markupBps;
}

export function rateProviderCost(amount: string, currency: string, terms: RatingTerms): RatedMoney {
  const multiplier = usagePriceMultiplierBps(terms);
  const total = multiplyBillingDecimalByBps(amount, multiplier);
  return {
    base: amount,
    markup: terms.mode === 'free' ? '0' : subtractBillingDecimals(total, amount),
    total,
    currency,
  };
}

function selectedCost(
  line: RawMeteringLine,
  params: {
    product: string;
    currency: string;
    missingCost: 'reject' | 'skip';
  },
): { amount: string; currency: string } | null {
  if (line.billingProduct !== params.product) {
    throw new AppError('INTERNAL', 502, 'LEDGER_METERING_PRODUCT_MISMATCH');
  }
  if (line.selectedProviderCost === null && line.currency === null) {
    if (params.missingCost === 'skip') return null;
    throw new AppError('INTERNAL', 502, 'LEDGER_METERING_COST_MISSING');
  }
  if (line.selectedProviderCost === null || line.currency !== params.currency) {
    throw new AppError('INTERNAL', 502, 'LEDGER_METERING_COST_MISMATCH');
  }
  return { amount: line.selectedProviderCost, currency: line.currency };
}

export function rateMeteringByCaller(params: {
  usage: NormalizedMeteringUsage;
  product: string;
  currency: string;
  terms: RatingTerms;
  unattributedCaller: string;
  missingCost?: 'reject' | 'skip';
}): RatedCallerTotal[] {
  const baseByCaller = new Map<string, string>();
  for (const line of params.usage.lines) {
    const cost = selectedCost(line, {
      product: params.product,
      currency: params.currency,
      missingCost: params.missingCost ?? 'reject',
    });
    if (!cost) continue;
    const caller = line.callerProduct ?? params.unattributedCaller;
    baseByCaller.set(caller, addBillingDecimals(baseByCaller.get(caller) ?? '0', cost.amount));
  }
  return [...baseByCaller.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([callerProduct, base]) => ({
      billingProduct: params.product,
      callerProduct,
      ...rateProviderCost(base, params.currency, params.terms),
    }));
}

export function rateMeteringTotal(params: {
  usage: NormalizedMeteringUsage;
  product: string;
  currency: string;
  terms: RatingTerms;
  missingCost?: 'reject' | 'skip';
}): RatedMoney {
  let base = '0';
  for (const line of params.usage.lines) {
    const cost = selectedCost(line, {
      product: params.product,
      currency: params.currency,
      missingCost: params.missingCost ?? 'reject',
    });
    if (cost) base = addBillingDecimals(base, cost.amount);
  }
  return rateProviderCost(base, params.currency, params.terms);
}
