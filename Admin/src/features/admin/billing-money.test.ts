import { describe, expect, it } from 'vitest';
import { billingMajorToMinor, billingMoney } from './billing-money';

describe('operator currency amount conversion', () => {
  it.each([
    ['20.00', 'GBP', '2000'],
    ['0.01', 'USD', '1'],
    ['20', 'JPY', '20'],
    ['1.234', 'KWD', '1234'],
    ['92233720368547758.07', 'GBP', '9223372036854775807'],
  ])('converts %s %s exactly', (major, currency, minor) => {
    expect(billingMajorToMinor(major, currency)).toBe(minor);
    expect(billingMoney(minor, currency).replaceAll(',', '')).toBe(`${major} ${currency}`);
  });

  it.each([
    ['20.001', 'GBP'],
    ['1.00', 'JPY'],
    ['1.2345', 'KWD'],
    ['92233720368547758.08', 'GBP'],
    ['1e2', 'GBP'],
    ['-1.00', 'GBP'],
  ])('rejects invalid %s %s', (major, currency) => {
    expect(() => billingMajorToMinor(major, currency)).toThrow();
  });
});
