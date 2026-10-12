import { z } from 'zod';
import { Prisma, type BillingSmsMonthlyPrice, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { smsCostReachesPrice, type SmsFxRates } from './billing-sms-fx-evidence.service.js';
import { lockSmsPolicyAcceptance, type SmsPolicyActor } from './billing-sms-policy-admin.service.js';
import {
  emailSmsPolicyAlert, raiseSmsPolicyAlert, resolveSmsPolicyAlerts, type SmsPolicyAlertLog,
} from './billing-sms-policy-alert.service.js';

/** The currencies a billing region can set; each has its own flat monthly number price. */
export const SMS_MONTHLY_PRICE_CURRENCIES = ['EUR', 'GBP', 'USD'] as const;
export type SmsMonthlyPriceCurrency = (typeof SMS_MONTHLY_PRICE_CURRENCIES)[number];

/** Exact two-place price; the Stripe monthly price is its minor-unit amount. */
export const SmsMonthlyPriceInput = z.object({
  amount: z.string().regex(/^(?:0|[1-9]\d{0,5})\.\d{2}$/).refine((value) => value !== '0.00'),
  currency: z.enum(SMS_MONTHLY_PRICE_CURRENCIES),
}).strict();
type MonthlyPriceDb = Pick<PrismaClient | Prisma.TransactionClient, 'billingSmsMonthlyPrice'>;

/** A currency's current flat monthly price: its newest appended row. */
export async function readSmsMonthlyPrice(db: MonthlyPriceDb, currency: string): Promise<BillingSmsMonthlyPrice> {
  const price = await db.billingSmsMonthlyPrice.findFirst({ where: { currency },
    orderBy: [{ setAt: 'desc' }, { id: 'desc' }] });
  if (!price) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_MONTHLY_PRICE_REQUIRED');
  return price;
}

export async function listSmsMonthlyPrices(db: MonthlyPriceDb = getAdminPrisma()) {
  return Promise.all(SMS_MONTHLY_PRICE_CURRENCIES.map(async (currency) =>
    serializeSmsMonthlyPrice(await readSmsMonthlyPrice(db, currency))));
}

export function serializeSmsMonthlyPrice(value: BillingSmsMonthlyPrice) {
  return { id: value.id, amount: value.amount.toFixed(2), currency: value.currency, set_by: value.setBy,
    set_by_user_id: value.setByUserId, set_at: value.setAt.toISOString() };
}

/** An operator edit appends a currency's new current price under the policy acceptance locks. */
export async function setSmsMonthlyPrice(actor: SmsPolicyActor, input: z.infer<typeof SmsMonthlyPriceInput>) {
  const value = SmsMonthlyPriceInput.parse(input);
  return getAdminPrisma().$transaction(async (tx) => {
    await lockSmsPolicyAcceptance(tx, { kind: 'operator', actor }, `monthly-number-price:${value.currency}`);
    return tx.billingSmsMonthlyPrice.create({ data: { amount: value.amount, currency: value.currency,
      setBy: 'operator', setByUserId: actor.userId, setAt: new Date() } });
  });
}

/** A monthly quote refused because the flat price would not cover the provider's own rental. */
export class SmsMonthlyBelowCostError extends AppError {
  public constructor(public readonly subject: string, public readonly detail: string) {
    super('BAD_REQUEST', 409, 'BILLING_SMS_MONTHLY_PRICE_BELOW_COST');
  }
}

function inPriceCurrency(amount: string, currency: string, target: string, rates: SmsFxRates): string {
  if (currency === target) return amount;
  const perEur = (code: string) => code === 'EUR' ? '1' : code === 'USD' ? rates.usdPerEur : rates.gbpPerEur ?? '0';
  return new Prisma.Decimal(amount).div(perEur(currency)).mul(perEur(target)).toFixed(4);
}

/**
 * The flat price for a monthly quote in its region's currency, never below cost:
 * the provider's monthly rental at the quote's accepted ECB rates must stay under it.
 */
export async function smsMonthlyTerms(db: MonthlyPriceDb, input: { country: string; currency: string;
  providerAmount: string; providerCurrency: string; rates: SmsFxRates }) {
  const price = await readSmsMonthlyPrice(db, input.currency);
  const priceAmount = price.amount.toFixed(2);
  // A currency the accepted snapshot cannot convert waits for the next accepted ECB document.
  if ([input.currency, input.providerCurrency].includes('GBP') && input.rates.gbpPerEur === null) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_FX_POLICY_REQUIRED');
  }
  if (smsCostReachesPrice({ costAmount: input.providerAmount, costCurrency: input.providerCurrency,
    priceAmount, priceCurrency: price.currency, rates: input.rates })) {
    const converted = inPriceCurrency(input.providerAmount, input.providerCurrency, price.currency, input.rates);
    throw new SmsMonthlyBelowCostError(`monthly:${input.country}:${price.currency}`, `${input.country} mobile ` +
      `numbers cost ${input.providerCurrency} ${input.providerAmount} a month at Twilio (${price.currency} ` +
      `${converted} at the accepted ECB rates), at or above the flat ${price.currency} ${priceAmount} price, ` +
      `so ${price.currency} monthly quotes for ${input.country} are refused. Raise the ${price.currency} price ` +
      `or stop offering ${input.country}.`);
  }
  return { finalAmount: priceAmount, finalCurrency: price.currency, monthlyPriceId: price.id };
}

/** Surface a refused country and currency on the SMS policies page and by email once; a later quote clears it. */
export async function recordSmsMonthlyQuoteOutcome(db: Pick<PrismaClient, 'billingSmsPolicyAlert'>,
  subject: string, refusal: SmsMonthlyBelowCostError | null, log?: SmsPolicyAlertLog & {
    warn?: (details: object, message: string) => void }): Promise<void> {
  const now = new Date();
  try {
    if (!refusal) {
      await resolveSmsPolicyAlerts(db, subject, now);
      return;
    }
    log?.warn?.({ subject, code: refusal.message }, refusal.detail);
    const condition = { kind: 'monthly_price_below_cost' as const, subject, message: refusal.detail };
    if (await raiseSmsPolicyAlert(db, condition, now) && log) await emailSmsPolicyAlert(condition, log);
  } catch (err) {
    log?.error({ err, subject }, 'failed to record SMS monthly price outcome');
  }
}
