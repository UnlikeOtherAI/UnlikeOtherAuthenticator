import { Prisma, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { z } from 'zod';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { SMS_FX_POLICY } from './billing-sms-fx-evidence.service.js';
import {
  emailSmsPolicyAlert, raiseSmsPolicyAlert, resolveSmsPolicyAlerts, type SmsPolicyAlertLog,
} from './billing-sms-policy-alert.service.js';
import type { CreditPurchaseCurrency } from './billing-stripe-catalog-provisioning-spec.js';

/** Stripe's FX Quotes API is a public preview reached through its preview API version. */
export const STRIPE_FX_QUOTES_API_VERSION = '2025-07-30.preview';
const MICROCREDITS_PER_CREDIT = 1_000_000n;
const RATE_PLACES = 12;

export type CreditPurchaseRate = {
  currency: CreditPurchaseCurrency;
  /** USD per one unit of the purchase currency; the customer receives the full conversion. */
  baseRate: string;
  source: 'usd' | 'stripe' | 'ecb';
  /** Stripe's fee-bearing rate, kept as evidence of the FX fee UOA absorbs. */
  exchangeRate: string | null;
  quoteId: string | null;
  fxSnapshotId: string | null;
  asOf: Date;
};
export type CreditPurchaseRateClient = Pick<Stripe, 'rawRequest'>;

function unavailable(): AppError {
  return new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_CREDIT_FX_RATE_UNAVAILABLE');
}

function decimal(value: number | string): string {
  const parsed = new Prisma.Decimal(value);
  if (!parsed.isFinite() || parsed.lte(0) || parsed.gte(1_000_000)) throw unavailable();
  return parsed.toDecimalPlaces(RATE_PLACES, Prisma.Decimal.ROUND_DOWN).toFixed();
}

const Quote = z.object({
  id: z.string().regex(/^fxq_[A-Za-z0-9_]+$/),
  lock_duration: z.literal('none'),
  to_currency: z.literal('usd'),
  created: z.number().int(),
  rates: z.record(z.string(), z.object({
    exchange_rate: z.number().positive(),
    rate_details: z.object({ base_rate: z.number().positive() }),
  })),
});

/** Stripe's live rate for one currency to USD: `lock_duration: none`, so no fee and no lock. */
async function stripeRate(currency: CreditPurchaseCurrency, stripe: CreditPurchaseRateClient,
  now: Date): Promise<CreditPurchaseRate> {
  const code = currency.toLowerCase();
  let quote: z.infer<typeof Quote>;
  try {
    const response = await stripe.rawRequest('POST', '/v1/fx_quotes',
      { to_currency: 'usd', from_currencies: [code], lock_duration: 'none' },
      { apiVersion: STRIPE_FX_QUOTES_API_VERSION });
    quote = Quote.parse(response);
  } catch {
    throw unavailable();
  }
  const rate = quote.rates[code];
  if (!rate) throw unavailable();
  return { currency, source: 'stripe', baseRate: decimal(rate.rate_details.base_rate),
    exchangeRate: decimal(rate.exchange_rate), quoteId: quote.id, fxSnapshotId: null,
    asOf: new Date(quote.created * 1000 || now.getTime()) };
}

/** The accepted ECB snapshot, used only when the deployment explicitly selects it. */
async function ecbRate(currency: CreditPurchaseCurrency, prisma: Pick<PrismaClient, 'billingSmsFxSnapshot'>,
  now: Date): Promise<CreditPurchaseRate> {
  const snapshot = await prisma.billingSmsFxSnapshot.findFirst({
    where: { policy: SMS_FX_POLICY, expiresAt: { gt: now }, ...(currency === 'GBP' ? { gbpPerEur: { not: null } } : {}) },
    orderBy: [{ rateDate: 'desc' }, { acceptedAt: 'desc' }],
  });
  if (!snapshot) throw unavailable();
  // ECB quotes units per EUR, so EUR is usd/eur and GBP is (usd/eur) / (gbp/eur).
  const usdPerEur = snapshot.usdPerEur;
  const base = currency === 'EUR' ? usdPerEur : usdPerEur.div(snapshot.gbpPerEur ?? 0);
  return { currency, source: 'ecb', baseRate: decimal(base.toFixed()), exchangeRate: null, quoteId: null,
    fxSnapshotId: snapshot.id, asOf: snapshot.rateDate };
}

/**
 * The rate a purchase in `currency` grants credits at, read when the checkout
 * is created. USD is 1:1. The source is `BILLING_CREDIT_FX_RATE_SOURCE`
 * (default `stripe`); an unavailable source refuses rather than switching.
 */
export async function readCreditPurchaseRate(currency: CreditPurchaseCurrency, deps: {
  stripe: CreditPurchaseRateClient; prisma?: Pick<PrismaClient, 'billingSmsFxSnapshot'>; now?: () => Date;
}): Promise<CreditPurchaseRate> {
  const now = deps.now?.() ?? new Date();
  if (currency === 'USD') {
    return { currency, source: 'usd', baseRate: '1', exchangeRate: null, quoteId: null, fxSnapshotId: null, asOf: now };
  }
  return getEnv().BILLING_CREDIT_FX_RATE_SOURCE === 'ecb'
    ? ecbRate(currency, deps.prisma ?? getAdminPrisma(), now)
    : stripeRate(currency, deps.stripe, now);
}

/** Credits for a payment at a rate, rounded down to whole credits: minor units × rate × 10,000,000. */
export function creditsForPayment(paymentAmountMinor: bigint, baseRate: string): bigint {
  const raw = new Prisma.Decimal(paymentAmountMinor.toString()).mul(baseRate).mul(10_000_000);
  const microcredits = BigInt(raw.toDecimalPlaces(0, Prisma.Decimal.ROUND_DOWN).toFixed());
  return microcredits - (microcredits % MICROCREDITS_PER_CREDIT);
}

function rateAlertMessage(currency: CreditPurchaseCurrency, source: 'stripe' | 'ecb'): string {
  return source === 'stripe'
    ? `Stripe's FX Quotes API did not return a ${currency} to USD rate, so ${currency} credit purchases are ` +
      'refused with BILLING_CREDIT_FX_RATE_UNAVAILABLE. Check the Stripe account\'s FX Quotes access, or set ' +
      'BILLING_CREDIT_FX_RATE_SOURCE=ecb to sell credits at the accepted ECB rate instead.'
    : `No current accepted ECB snapshot converts ${currency} to USD, so ${currency} credit purchases are ` +
      'refused with BILLING_CREDIT_FX_RATE_UNAVAILABLE. Accept a fresh ECB document in Admin > Billing > SMS policies.';
}

/**
 * The purchase rate, with its operator alert: an unavailable source opens one
 * `credit_fx_rate_unavailable` alert per currency and source (emailed once) and
 * refuses; the next rate read closes it.
 */
export async function readCreditPurchaseRateWithAlert(currency: CreditPurchaseCurrency, deps: {
  stripe: CreditPurchaseRateClient; prisma?: Pick<PrismaClient, 'billingSmsFxSnapshot' | 'billingSmsPolicyAlert'>;
  now?: () => Date; log?: SmsPolicyAlertLog;
}): Promise<CreditPurchaseRate> {
  if (currency === 'USD') return readCreditPurchaseRate(currency, deps);
  const prisma = deps.prisma ?? getAdminPrisma();
  const source = getEnv().BILLING_CREDIT_FX_RATE_SOURCE;
  const subject = `credit-purchase:${source}:${currency}`;
  const now = deps.now?.() ?? new Date();
  try {
    const rate = await readCreditPurchaseRate(currency, { ...deps, prisma });
    await resolveSmsPolicyAlerts(prisma, subject, now).catch((err: unknown) =>
      deps.log?.error({ err, subject }, 'failed to resolve credit FX rate alert'));
    return rate;
  } catch (error) {
    if (!(error instanceof AppError) || error.message !== 'BILLING_CREDIT_FX_RATE_UNAVAILABLE') throw error;
    const condition = { kind: 'credit_fx_rate_unavailable' as const, subject, message: rateAlertMessage(currency, source) };
    try {
      if (await raiseSmsPolicyAlert(prisma, condition, now) && deps.log) await emailSmsPolicyAlert(condition, deps.log);
    } catch (err) {
      deps.log?.error({ err, subject }, 'failed to record credit FX rate alert');
    }
    throw error;
  }
}
