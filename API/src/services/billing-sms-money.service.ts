import { Prisma, type BillingSmsQuote } from '@prisma/client';
import { AppError } from '../utils/errors.js';

const SCALE = 10n ** 18n;
function scaled(value: string): bigint {
  if (!/^(0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(value)) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_AMOUNT_UNSUPPORTED');
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
}
function decimal(value: bigint): Prisma.Decimal {
  const digits = value.toString().padStart(19, '0');
  return new Prisma.Decimal(`${digits.slice(0, -18)}.${digits.slice(-18)}`);
}
export function sumSmsAmounts(values: string[]): Prisma.Decimal {
  return decimal(values.reduce((sum, value) => sum + scaled(value), 0n));
}
export function multiplySmsAmount(value: string, count: number): Prisma.Decimal {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_SMS_SEGMENT_BOUND_INVALID');
  }
  return decimal(scaled(value) * BigInt(count));
}
/** Preserve exact provider evidence under the accepted UOA FX snapshot; never round raw cost. */
export function smsProviderUsd(amount: string, currency: string, usdPerEur: string): Prisma.Decimal {
  const raw = scaled(amount);
  if (currency === 'USD') return decimal(raw);
  if (currency !== 'EUR') throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_CURRENCY_UNSUPPORTED');
  const product = raw * scaled(usdPerEur);
  if (product % SCALE !== 0n) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_FX_PRECISION_UNSUPPORTED');
  return decimal(product / SCALE);
}
export function smsCreditsToMicrocredits(credits: string): bigint {
  const value = scaled(credits);
  if (value % (10n ** 12n) !== 0n || value <= 0n || value / (10n ** 12n) > 9_223_372_036_854_775_807n) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_SMS_CREDITS_INVALID');
  }
  return value / (10n ** 12n);
}
export function smsMicrocredits(value: bigint): string {
  const digits = value.toString().padStart(7, '0');
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
}
export async function lockSmsQuote(tx: Prisma.TransactionClient, input: {
  quoteId: string; serviceId: string; orgId: string; direction: 'inbound' | 'outbound';
  destination: string | null; accountSid: string; now: Date;
}): Promise<{ quote: BillingSmsQuote; usdPerEur: string }> {
  const quote = await tx.billingSmsQuote.findUnique({ where: { id: input.quoteId } });
  if (!quote || quote.serviceId !== input.serviceId || quote.orgId !== input.orgId ||
      quote.direction !== input.direction || quote.destination !== input.destination ||
      quote.finalCurrency !== 'USD' || quote.expiresAt <= input.now || !quote.providerBoundAmount || !quote.routePolicyId) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_QUOTE_NOT_ACCEPTABLE');
  }
  const [fx, policy] = await Promise.all([
    tx.billingSmsFxSnapshot.findUnique({ where: { id: quote.fxSnapshotId } }),
    tx.billingSmsRoutePolicy.findUnique({ where: { id: quote.routePolicyId } }),
  ]);
  if (!fx || fx.expiresAt <= input.now || !policy || policy.expiresAt <= input.now ||
      policy.accountSid !== input.accountSid || policy.country !== quote.country ||
      policy.direction !== quote.direction || policy.currency !== quote.providerCurrency) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_ROUTE_BOUND_UNAVAILABLE');
  }
  return { quote, usdPerEur: fx.usdPerEur.toFixed() };
}
