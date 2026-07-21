import { describe, expect, it } from 'vitest';

import { majorAmountToMinorRounded } from '../../src/services/billing-money.service.js';

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
});
