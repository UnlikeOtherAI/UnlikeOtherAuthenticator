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

/** Presentation only: never converts exact minor-unit strings through a JS number. */
export function billingMoney(amountMinor: string, currency: string): string {
  if (!/^-?\d+$/.test(amountMinor)) return `${amountMinor} ${currency} minor units`;
  const digits = zeroDigits.has(currency) ? 0 : threeDigits.has(currency) ? 3 : 2;
  const negative = amountMinor.startsWith('-');
  const value = (negative ? amountMinor.slice(1) : amountMinor).padStart(digits + 1, '0');
  const whole = digits ? value.slice(0, -digits) : value;
  const fraction = digits ? `.${value.slice(-digits)}` : '';
  return `${negative ? '−' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction} ${currency}`;
}
