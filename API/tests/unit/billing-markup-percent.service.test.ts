import { describe, expect, it } from 'vitest';
import { markupPercentToBps } from '../../src/services/billing-markup-percent.service.js';

describe('operator markup percentages', () => {
  it.each([
    ['0', 0],
    ['0.01', 1],
    ['1.2', 120],
    ['30', 3000],
    ['30.00', 3000],
    ['1000.00', 100000],
  ])('converts %s exactly to %i basis points', (percent, bps) => {
    expect(markupPercentToBps(percent)).toBe(bps);
  });

  it.each(['-1', '00.01', '1.234', '1e2', '1,20', '1000.01', ' 30', '30%'])(
    'rejects ambiguous or invalid input %s',
    (percent) => expect(() => markupPercentToBps(percent)).toThrow('INVALID_TARIFF_MARKUP_PERCENT'),
  );
});
