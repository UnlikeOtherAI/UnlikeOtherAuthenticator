import { describe, expect, it } from 'vitest';

import {
  applyCreditOffsetToStripeCharges, type CumulativeCharge,
} from '../../src/services/billing-stripe-usage-validation.service.js';

function charges(keys: string[], quantity = 1n): Map<string, CumulativeCharge> {
  return new Map(keys.map((key) => [key, { billingProduct: 'nessie',
    callerProduct: key, currency: 'USD', amount: '0.00000001', quantity }]));
}

describe('stable Stripe scarce credit allocation', () => {
  it('assigns the last fractional unit using binary identity order in any input order', () => {
    for (const keys of [['a', 'ä', 'A'], ['ä', 'A', 'a'], ['A', 'a', 'ä']]) {
      const net = applyCreditOffsetToStripeCharges(charges(keys), 1n, new Map());
      expect(net.get('A')?.quantity).toBe(0n);
      expect(net.get('a')?.quantity).toBe(1n);
      expect(net.get('ä')?.quantity).toBe(1n);
      expect([...net.values()].reduce((total, row) => total + row.quantity, 0n)).toBe(2n);
    }
  });

  it('preserves prior issuer bucket offsets while allocating only new credits', () => {
    const previous = new Map([
      ['A', { cumulativeGrossMeterQuantity: 1n, cumulativeMeterQuantity: 1n }],
      ['a', { cumulativeGrossMeterQuantity: 1n, cumulativeMeterQuantity: 0n }],
      ['ä', { cumulativeGrossMeterQuantity: 1n, cumulativeMeterQuantity: 1n }],
    ]);
    const net = applyCreditOffsetToStripeCharges(charges(['ä', 'a', 'A'], 2n), 2n, previous);
    expect(net.get('A')?.quantity).toBe(1n);
    expect(net.get('a')?.quantity).toBe(1n);
    expect(net.get('ä')?.quantity).toBe(2n);
    expect([...net.values()].reduce((total, row) => total + row.quantity, 0n)).toBe(4n);
  });
});
