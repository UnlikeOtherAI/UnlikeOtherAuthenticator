/** Presentation only: never converts exact minor-unit strings through a JS number. */
export function billingMoney(amountMinor: string, currency: string): string {
  if (!/^-?\d+$/.test(amountMinor)) return `${amountMinor} ${currency} minor units`;
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency })
    .resolvedOptions().maximumFractionDigits ?? 2;
  const negative = amountMinor.startsWith('-');
  const value = (negative ? amountMinor.slice(1) : amountMinor).padStart(digits + 1, '0');
  const whole = digits ? value.slice(0, -digits) : value;
  const fraction = digits ? `.${value.slice(-digits)}` : '';
  return `${negative ? '−' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction} ${currency}`;
}
