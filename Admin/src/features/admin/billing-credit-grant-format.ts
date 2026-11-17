import type { BillingCreditAmount } from '../../schemas/billing-credit-grants';

const MICROCREDITS_PER_CREDIT = 1_000_000n;
const MICROCREDITS_PER_USD = 1_000_000_000n;
const WHOLE_CREDITS = /^[1-9]\d{0,7}$/;

function grouped(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function scaled(microcredits: bigint, scale: bigint, minFraction: number): string {
  const negative = microcredits < 0n;
  const magnitude = negative ? -microcredits : microcredits;
  const digits = scale.toString().length - 1;
  const fraction = (magnitude % scale).toString().padStart(digits, '0').replace(/0+$/, '');
  const shown = fraction.padEnd(minFraction, '0');
  return `${negative ? '-' : ''}${grouped((magnitude / scale).toString())}${shown ? `.${shown}` : ''}`;
}

/** "12,500 credits" from exact microcredits. */
export function creditGrantCredits(amount: Pick<BillingCreditAmount, 'microcredits'>): string {
  return `${scaled(BigInt(amount.microcredits), MICROCREDITS_PER_CREDIT, 0)} credits`;
}

/** "US$12.50" from exact microcredits; sub-cent values keep their digits. */
export function creditGrantUsd(amount: Pick<BillingCreditAmount, 'microcredits'>): string {
  const value = scaled(BigInt(amount.microcredits), MICROCREDITS_PER_USD, 2);
  return value.startsWith('-') ? `-US$${value.slice(1)}` : `US$${value}`;
}

/** The whole-credit input as microcredits, or null when it is not a grant the API accepts. */
export function creditGrantInputMicrocredits(credits: string, maxCredits: string): bigint | null {
  const value = credits.trim();
  if (!WHOLE_CREDITS.test(value) || BigInt(value) > BigInt(maxCredits)) return null;
  return BigInt(value) * MICROCREDITS_PER_CREDIT;
}

/** A fresh 64-hex key per intended grant, kept across retries of the same grant. */
export function newCreditGrantKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
}
