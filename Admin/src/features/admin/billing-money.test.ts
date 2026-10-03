import { describe, expect, it } from 'vitest';
import { billingMoney } from './billing-money';

describe('billingMoney', () => {
  it('retains every minor unit above the safe integer range', () => {
    expect(billingMoney('9007199254740993123', 'USD')).toBe('90,071,992,547,409,931.23 USD');
    expect(billingMoney('1', 'GBP')).toBe('0.01 GBP');
  });
  it('uses the currency exponent without rounding', () => {
    expect(billingMoney('12345', 'JPY')).toBe('12,345 JPY');
    expect(billingMoney('12345', 'KWD')).toBe('12.345 KWD');
    expect(billingMoney('12345', 'ISK')).toBe('123.45 ISK');
    expect(billingMoney('12345', 'IQD')).toBe('12.345 IQD');
    expect(billingMoney('-123', 'USD')).toBe('−1.23 USD');
  });
});
