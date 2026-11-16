import type { BillingTariff } from '../../schemas/billing';
import { billingMoney } from './billing-money';

// One presentation vocabulary for every billing table and dialog.
const locale = 'en-GB';

function parsed(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Table date: "16 Nov 2026". */
export function billingDate(value: string | null | undefined): string {
  return parsed(value)?.toLocaleDateString(locale, {
    day: 'numeric', month: 'short', year: 'numeric',
  }) ?? '—';
}

/** Detail and tooltip date: "16 Nov 2026, 18:50". */
export function billingDateTime(value: string | null | undefined): string {
  return parsed(value)?.toLocaleString(locale, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }) ?? '—';
}

/**
 * A UTC calendar day (an invoice's issue or due date, a capacity change that starts at a UTC
 * midnight): "16 Nov 2026", the same day wherever the operator is.
 */
export function billingUtcDate(value: string | null | undefined): string {
  return parsed(value)?.toLocaleDateString(locale, {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }) ?? '—';
}

/** The UTC billing month of an instant, as the API writes it: "2026-11". */
export function billingMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** The month a tariff change made now starts in. Mirrors the API's `nextUtcBillingMonth`. */
export function nextBillingMonth(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
}

/** "2026-12" → "1 December 2026". */
export function billingMonthStart(month: string): string {
  return new Date(`${month}-01T00:00:00.000Z`).toLocaleDateString(locale, {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

export function billingMonthIsFuture(month: string | null, now: Date = new Date()): boolean {
  return month !== null && month > billingMonth(now);
}

/** "pay_as_you_go" → "Pay as you go". */
export function billingLabel(value: string): string {
  const words = value.replaceAll('_', ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '—';
}

/** Who made a change. Migrations and jobs sign as `system:<name>`. */
export function billingActor(email: string | null | undefined): string {
  if (!email) return '—';
  return email.startsWith('system') ? 'System' : email;
}

export function billingTariffName(tariff: Pick<BillingTariff, 'name' | 'key' | 'version'>): string {
  return `${tariff.name} · ${tariff.key} v${tariff.version}`;
}

type SummaryTerms = Pick<BillingTariff,
  'mode' | 'collection_mode' | 'markup_bps' | 'usage_payment_mode' | 'monthly_subscription'>;

/** What a customer on this tariff pays, in one line: monthly fee · usage · how it is collected. */
export function billingTariffSummary(tariff: SummaryTerms): string {
  const monthly = /^0+$/.test(tariff.monthly_subscription.amount_minor)
    ? 'No monthly fee'
    : `${billingMoney(tariff.monthly_subscription.amount_minor, tariff.monthly_subscription.currency)} ${
      tariff.monthly_subscription.charge_basis === 'per_seat' ? 'per seat' : 'per month'}`;
  const payment = tariff.usage_payment_mode === 'prepaid' ? 'prepaid' : 'pay as you go';
  const usage = tariff.mode === 'free'
    ? 'usage free'
    : `${tariff.markup_bps === 0 ? 'usage at cost' : `usage +${tariff.markup_bps / 100}%`}, ${payment}`;
  const collection = tariff.collection_mode === 'stripe'
    ? 'card (Stripe)'
    : tariff.collection_mode === 'manual' ? 'invoice' : 'not collected';
  return `${monthly} · ${usage} · ${collection}`;
}
