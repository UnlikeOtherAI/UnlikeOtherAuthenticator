import { describe, expect, it } from 'vitest';

import {
  creditGrantCredits, creditGrantInputMicrocredits, creditGrantUsd, newCreditGrantKey,
} from './billing-credit-grant-format';

describe('credit grant formatting', () => {
  it('shows exact credits and dollars from microcredits', () => {
    expect(creditGrantCredits({ microcredits: '12500000000' })).toBe('12,500 credits');
    expect(creditGrantUsd({ microcredits: '12500000000' })).toBe('US$12.50');
    expect(creditGrantCredits({ microcredits: '0' })).toBe('0 credits');
    expect(creditGrantUsd({ microcredits: '0' })).toBe('US$0.00');
    expect(creditGrantCredits({ microcredits: '1500000' })).toBe('1.5 credits');
    expect(creditGrantUsd({ microcredits: '1000000' })).toBe('US$0.001');
    expect(creditGrantUsd({ microcredits: '-2000000000' })).toBe('-US$2.00');
  });

  it('accepts only whole credits within the limit', () => {
    expect(creditGrantInputMicrocredits('10000', '10000000')).toBe(10_000_000_000n);
    expect(creditGrantInputMicrocredits(' 5 ', '10000000')).toBe(5_000_000n);
    for (const refused of ['', '0', '-5', '1.5', '1e3', '010', '10000001']) {
      expect(creditGrantInputMicrocredits(refused, '10000000')).toBeNull();
    }
  });

  it('makes a distinct 64-hex key for each intended grant', () => {
    const first = newCreditGrantKey();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(newCreditGrantKey()).not.toBe(first);
  });
});
