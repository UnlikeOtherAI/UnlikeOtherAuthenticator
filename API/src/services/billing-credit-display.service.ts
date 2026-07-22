import type {
  BillingCreditAmount,
  BillingCreditsPaymentMoney,
  BillingRecurringAddonMoney,
} from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';

const MICROCREDITS_PER_CREDIT = 1_000_000n;

function scaledDecimal(value: bigint, scale: number): string {
  if (value === 0n) return '0';
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? '' : digits.slice(-scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function grouped(value: string): string {
  const negative = value.startsWith('-');
  const [whole, fraction] = (negative ? value.slice(1) : value).split('.');
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${groupedWhole}${fraction ? `.${fraction}` : ''}`;
}

function usdDisplay(value: string): string {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const padded = fraction.padEnd(3, '0');
  let amountMinor = BigInt(whole) * 100n + BigInt(padded.slice(0, 2));
  if (padded[2] >= '5') amountMinor += 1n;
  if (negative) amountMinor = -amountMinor;
  const rounded = scaledDecimal(amountMinor, 2);
  const roundedNegative = rounded.startsWith('-');
  const [roundedWhole, roundedFraction = ''] = (roundedNegative ? rounded.slice(1) : rounded).split(
    '.',
  );
  const fixed = `${roundedWhole}.${roundedFraction.padEnd(2, '0')}`;
  return `${roundedNegative ? '-' : ''}US$${grouped(fixed)}`;
}

export function billingWholeCredits(microcredits: bigint): bigint {
  let credits = microcredits / MICROCREDITS_PER_CREDIT;
  if (microcredits < 0n && microcredits % MICROCREDITS_PER_CREDIT !== 0n) credits -= 1n;
  return credits;
}

export function billingCreditAmount(microcredits: bigint): BillingCreditAmount {
  if (microcredits % 10n !== 0n) {
    throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_PRECISION_INVALID');
  }
  const wholeCredits = billingWholeCredits(microcredits);
  const credits = wholeCredits.toString();
  const usd = scaledDecimal(wholeCredits, 3);
  return {
    credits,
    display: `${grouped(credits)} ${wholeCredits === 1n || wholeCredits === -1n ? 'credit' : 'credits'}`,
    usd_equivalent: {
      amount: usd,
      currency: 'USD',
      display: usdDisplay(usd),
    },
  };
}

export function billingCreditsPaymentMoney(amountMinor: bigint): BillingCreditsPaymentMoney {
  if (amountMinor < 0n) {
    throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_PAYMENT_INVALID');
  }
  const amount = scaledDecimal(amountMinor, 2);
  return {
    amount,
    amount_minor: amountMinor.toString(),
    currency: 'USD',
    display: usdDisplay(amount),
  };
}

export function billingRecurringAddonMoney(
  amountMinor: bigint,
  currency: string,
): BillingRecurringAddonMoney {
  if (amountMinor < 0n || !/^[A-Z]{3}$/.test(currency)) {
    throw new AppError('INTERNAL', 500, 'BILLING_RECURRING_ADDON_PRICE_INVALID');
  }
  const amount = scaledDecimal(amountMinor, 2);
  return {
    amount,
    amount_minor: amountMinor.toString(),
    currency,
    display: `${currency === 'USD' ? usdDisplay(amount) : `${currency} ${grouped(amount)}`}/month`,
  };
}
