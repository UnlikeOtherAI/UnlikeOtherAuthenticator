import type {
  BillingCreditAmount,
  BillingCreditsPaymentMoney,
  BillingRecurringAddonMoney,
} from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';

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
  const decimals = fraction.length >= 2 ? fraction : fraction.padEnd(2, '0');
  return `${negative ? '-' : ''}US$${grouped(`${whole}.${decimals}`)}`;
}

export function billingCreditAmount(microcredits: bigint): BillingCreditAmount {
  if (microcredits % 10n !== 0n) {
    throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_PRECISION_INVALID');
  }
  const credits = scaledDecimal(microcredits, 6);
  const usd = scaledDecimal(microcredits, 9);
  return {
    credits,
    display: `${grouped(credits)} credits`,
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
