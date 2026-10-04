// Match the admin API's currencyMinorDigits contract, including its two-digit fallback.
// Intl's current ISO exponent can differ (for example ISK); it cannot reinterpret stored units.
const zeroDigits = new Set([
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
const threeDigits = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

function minorDigits(currency: string): number {
  return zeroDigits.has(currency) ? 0 : threeDigits.has(currency) ? 3 : 2;
}

/** Converts an operator's decimal currency amount to exact minor units. */
export function billingMajorToMinor(amount: string, currency: string): string {
  if (!/^(0|[1-9]\d*)(?:\.\d+)?$/.test(amount) || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error('Enter a non-negative currency amount.');
  }
  const [whole, fraction = ''] = amount.split('.');
  const digits = minorDigits(currency);
  if (fraction.length > digits) {
    throw new Error(`Enter at most ${digits} decimal places for ${currency}.`);
  }
  const minor = BigInt(whole) * 10n ** BigInt(digits) +
    BigInt(fraction.padEnd(digits, '0') || '0');
  if (minor > 9_223_372_036_854_775_807n) {
    throw new Error('Amount is too large.');
  }
  return minor.toString();
}

/** Presentation only: never converts exact minor-unit strings through a JS number. */
export function billingMoney(amountMinor: string, currency: string): string {
  if (!/^-?\d+$/.test(amountMinor)) return `${amountMinor} ${currency} minor units`;
  const digits = minorDigits(currency);
  const negative = amountMinor.startsWith('-');
  const value = (negative ? amountMinor.slice(1) : amountMinor).padStart(digits + 1, '0');
  const whole = digits ? value.slice(0, -digits) : value;
  const fraction = digits ? `.${value.slice(-digits)}` : '';
  return `${negative ? '−' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction} ${currency}`;
}
