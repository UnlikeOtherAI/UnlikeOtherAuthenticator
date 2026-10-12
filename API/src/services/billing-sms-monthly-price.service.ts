import { z } from 'zod';
import { Prisma, type BillingSmsMonthlyPrice, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { smsCostReachesPrice } from './billing-sms-fx-evidence.service.js';
import { lockSmsPolicyAcceptance, type SmsPolicyActor } from './billing-sms-policy-admin.service.js';
import {
  emailSmsPolicyAlert, raiseSmsPolicyAlert, resolveSmsPolicyAlerts, type SmsPolicyAlertLog,
} from './billing-sms-policy-alert.service.js';

/** Exact two-place price; the Stripe monthly price is its minor-unit amount. */
export const SmsMonthlyPriceInput = z.object({
  amount: z.string().regex(/^(?:0|[1-9]\d{0,5})\.\d{2}$/).refine((value) => value !== '0.00'),
  currency: z.enum(['EUR', 'USD']),
}).strict();
type MonthlyPriceDb = Pick<PrismaClient | Prisma.TransactionClient, 'billingSmsMonthlyPrice'>;

/** The current flat monthly price: the newest appended row. */
export async function readSmsMonthlyPrice(db: MonthlyPriceDb): Promise<BillingSmsMonthlyPrice> {
  const price = await db.billingSmsMonthlyPrice.findFirst({ orderBy: [{ setAt: 'desc' }, { id: 'desc' }] });
  if (!price) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_MONTHLY_PRICE_REQUIRED');
  return price;
}

export function serializeSmsMonthlyPrice(value: BillingSmsMonthlyPrice) {
  return { id: value.id, amount: value.amount.toFixed(2), currency: value.currency, set_by: value.setBy,
    set_by_user_id: value.setByUserId, set_at: value.setAt.toISOString() };
}

/** An operator edit appends a new current price under the same authority locks as policy acceptance. */
export async function setSmsMonthlyPrice(actor: SmsPolicyActor, input: z.infer<typeof SmsMonthlyPriceInput>) {
  const value = SmsMonthlyPriceInput.parse(input);
  return getAdminPrisma().$transaction(async (tx) => {
    await lockSmsPolicyAcceptance(tx, { kind: 'operator', actor }, 'monthly-number-price');
    return tx.billingSmsMonthlyPrice.create({ data: { amount: value.amount, currency: value.currency,
      setBy: 'operator', setByUserId: actor.userId, setAt: new Date() } });
  });
}

/** A monthly quote refused because the flat price would not cover the provider's own rental. */
export class SmsMonthlyBelowCostError extends AppError {
  public constructor(public readonly country: string, public readonly detail: string) {
    super('BAD_REQUEST', 409, 'BILLING_SMS_MONTHLY_PRICE_BELOW_COST');
  }
}

/**
 * The flat price for a monthly quote, never below cost: the provider's monthly
 * rental, converted at the quote's accepted ECB rate, must stay under it.
 */
export async function smsMonthlyTerms(db: MonthlyPriceDb, input: { country: string; providerAmount: string;
  providerCurrency: string; usdPerEur: string }) {
  const price = await readSmsMonthlyPrice(db);
  const priceAmount = price.amount.toFixed(2);
  if (smsCostReachesPrice({ costAmount: input.providerAmount, costCurrency: input.providerCurrency,
    priceAmount, priceCurrency: price.currency, usdPerEur: input.usdPerEur })) {
    const cost = new Prisma.Decimal(input.providerAmount);
    const converted = input.providerCurrency === price.currency ? cost
      : price.currency === 'EUR' ? cost.div(input.usdPerEur) : cost.mul(input.usdPerEur);
    throw new SmsMonthlyBelowCostError(input.country, `${input.country} mobile numbers cost ` +
      `${input.providerCurrency} ${input.providerAmount} a month at Twilio (${price.currency} ` +
      `${converted.toFixed(4)} at USD/EUR ${input.usdPerEur}), at or above the flat ${price.currency} ` +
      `${priceAmount} price, so monthly quotes for ${input.country} are refused. Raise the price or stop ` +
      `offering ${input.country}.`);
  }
  return { finalAmount: priceAmount, finalCurrency: price.currency, monthlyPriceId: price.id };
}

/** Surface a refused country on the SMS policies page and by email once; a later quote clears it. */
export async function recordSmsMonthlyQuoteOutcome(db: Pick<PrismaClient, 'billingSmsPolicyAlert'>,
  country: string, refusal: SmsMonthlyBelowCostError | null, log?: SmsPolicyAlertLog & {
    warn?: (details: object, message: string) => void }): Promise<void> {
  const subject = `monthly:${country}`;
  const now = new Date();
  try {
    if (!refusal) {
      await resolveSmsPolicyAlerts(db, subject, now);
      return;
    }
    log?.warn?.({ country, code: refusal.message }, refusal.detail);
    const condition = { kind: 'monthly_price_below_cost' as const, subject, message: refusal.detail };
    if (await raiseSmsPolicyAlert(db, condition, now) && log) await emailSmsPolicyAlert(condition, log);
  } catch (err) {
    log?.error({ err, country }, 'failed to record SMS monthly price outcome');
  }
}
