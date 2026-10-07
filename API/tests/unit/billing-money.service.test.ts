import { describe, expect, it } from 'vitest';

import { exactMoney, majorAmountToMinorRounded } from '../../src/services/billing-money.service.js';

describe('billing money currency rounding', () => {
  it('rounds only at the requested currency boundary', () => {
    expect(majorAmountToMinorRounded('1.0049', 'USD')).toBe(100n);
    expect(majorAmountToMinorRounded('1.005', 'USD')).toBe(101n);
    expect(majorAmountToMinorRounded('1.5', 'JPY')).toBe(2n);
    expect(majorAmountToMinorRounded('1.2345', 'KWD')).toBe(1_235n);
    expect(majorAmountToMinorRounded('2', 'GBP')).toBe(200n);
  });

  it('rounds credits symmetrically', () => {
    expect(majorAmountToMinorRounded('-1.0049', 'USD')).toBe(-100n);
    expect(majorAmountToMinorRounded('-1.005', 'USD')).toBe(-101n);
  });

  it('shows currency precision without changing exact amounts or rounding intermediate costs', () => {
    expect(exactMoney('0.6', 'USD')).toEqual({ amount: '0.6', currency: 'USD', display: '$0.60' });
    expect(exactMoney('50', 'USD').display).toBe('$50.00');
    expect(exactMoney('-1234.5', 'GBP').display).toBe('-£1,234.50');
    expect(exactMoney('0', 'EUR').display).toBe('€0.00');
    expect(exactMoney('50', 'JPY').display).toBe('JPY 50');
    expect(exactMoney('1.2', 'KWD').display).toBe('KWD 1.200');
    expect(exactMoney('0.000001', 'USD').display).toBe('$0.000001');
  });
});
