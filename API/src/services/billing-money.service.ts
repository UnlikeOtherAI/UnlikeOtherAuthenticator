import type { ExactMoney } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';

type Decimal = { coefficient: bigint; scale: number };

const DECIMAL_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);
const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€',
  GBP: '£',
  USD: '$',
};

function powerOfTen(value: number): bigint {
  return 10n ** BigInt(value);
}

function parseDecimal(value: string): Decimal {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new AppError('INTERNAL', 502, 'BILLING_DECIMAL_INVALID');
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${whole}${fraction}`);
  return {
    coefficient: negative ? -coefficient : coefficient,
    scale: fraction.length,
  };
}

function serializeDecimal(value: Decimal): string {
  if (value.coefficient === 0n) return '0';
  const negative = value.coefficient < 0n;
  const digits = (negative ? -value.coefficient : value.coefficient).toString();
  if (value.scale === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(value.scale + 1, '0');
  const whole = padded.slice(0, -value.scale);
  const fraction = padded.slice(-value.scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function align(left: Decimal, right: Decimal): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * powerOfTen(scale - left.scale),
    right.coefficient * powerOfTen(scale - right.scale),
    scale,
  ];
}

export function addBillingDecimals(left: string, right: string): string {
  const [leftValue, rightValue, scale] = align(parseDecimal(left), parseDecimal(right));
  return serializeDecimal({ coefficient: leftValue + rightValue, scale });
}

export function subtractBillingDecimals(left: string, right: string): string {
  const [leftValue, rightValue, scale] = align(parseDecimal(left), parseDecimal(right));
  return serializeDecimal({ coefficient: leftValue - rightValue, scale });
}

export function multiplyBillingDecimalByBps(value: string, basisPoints: number): string {
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) {
    throw new AppError('INTERNAL', 500, 'BILLING_MULTIPLIER_INVALID');
  }
  const decimal = parseDecimal(value);
  return serializeDecimal({
    coefficient: decimal.coefficient * BigInt(basisPoints),
    scale: decimal.scale + 4,
  });
}

export function billingDecimalRatioBasisPoints(part: string, total: string): number | null {
  const [partValue, totalValue] = align(parseDecimal(part), parseDecimal(total));
  if (partValue < 0n || totalValue <= 0n || partValue > totalValue) return null;
  const rounded = (partValue * 10_000n + totalValue / 2n) / totalValue;
  return Number(rounded);
}

export function sumBillingDecimals(values: string[]): string {
  return values.reduce(addBillingDecimals, '0');
}

export function currencyMinorDigits(currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  return 2;
}

export function minorAmountToMajor(amountMinor: string, currency: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(amountMinor) || !/^[A-Z]{3}$/.test(currency)) {
    throw new AppError('INTERNAL', 500, 'BILLING_MONEY_INVALID');
  }
  return serializeDecimal({
    coefficient: BigInt(amountMinor),
    scale: currencyMinorDigits(currency),
  });
}

function groupedDigits(value: string): string {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction] = unsigned.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

export function exactMoney(amount: string, currency: string): ExactMoney {
  const normalized = serializeDecimal(parseDecimal(amount));
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AppError('INTERNAL', 502, 'BILLING_CURRENCY_INVALID');
  }
  const symbol = CURRENCY_SYMBOLS[currency];
  return {
    amount: normalized,
    currency,
    display: symbol
      ? `${normalized.startsWith('-') ? '-' : ''}${symbol}${groupedDigits(normalized).replace('-', '')}`
      : `${currency} ${groupedDigits(normalized)}`,
  };
}
