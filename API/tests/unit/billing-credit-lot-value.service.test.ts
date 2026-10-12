import { describe, expect, it } from 'vitest';

import { creditBalanceValue, creditMovementValue } from '../../src/services/billing-credit-lot-value.service.js';

// A USD 10.00 lot bought before the region was chosen, then a EUR 25.00 lot at 1.16123.
const usdLot = { currency: 'USD', usdPerUnit: '1', remainingMicrocredits: 10_000_000_000n, sequence: 1 };
const eurLot = { currency: 'EUR', usdPerUnit: '1.16123', remainingMicrocredits: 29_030_000_000n, sequence: 2 };
const europe = (usdPerUnit: string | null) => ({ currency: 'EUR' as const, usdPerUnit });

describe('credit lot value', () => {
  it('keeps a region-currency lot at the rate it was bought at, whatever the region rate', () => {
    for (const rate of ['1.05', '1.16123', '1.30']) {
      expect(creditBalanceValue({ lots: [eurLot], debtMicrocredits: 0n, reservedMicrocredits: 0n,
        target: europe(rate) })).toEqual({ currency: 'EUR', amount: '24.99', amountMinor: 2_499n });
    }
  });

  it('values credits bought in USD at the region\'s captured rate, and refuses to guess one', () => {
    expect(creditBalanceValue({ lots: [usdLot, eurLot], debtMicrocredits: 0n, reservedMicrocredits: 0n,
      target: europe('1.25') })).toMatchObject({ amount: '32.99' });
    expect(creditBalanceValue({ lots: [usdLot, eurLot], debtMicrocredits: 0n, reservedMicrocredits: 0n,
      target: europe(null) })).toBeNull();
    expect(creditBalanceValue({ lots: [usdLot], debtMicrocredits: 0n, reservedMicrocredits: 0n,
      target: { currency: 'USD', usdPerUnit: '1' } })).toEqual({ currency: 'USD', amount: '10.00', amountMinor: 1_000n });
  });

  it('takes a hold from the oldest lot, where its settlement will draw, and gives it back on release', () => {
    const held = creditBalanceValue({ lots: [eurLot, usdLot], debtMicrocredits: 0n,
      reservedMicrocredits: 4_000_000_000n, target: europe('1.25') });
    // The hold comes out of the USD lot (sequence 1): USD 6.00 at 1.25 = EUR 4.80, plus EUR 24.99.
    expect(held).toMatchObject({ amount: '29.79' });
    const released = creditBalanceValue({ lots: [eurLot, usdLot], debtMicrocredits: 0n, reservedMicrocredits: 0n,
      target: europe('1.25') });
    expect(released).toMatchObject({ amount: '32.99' });
  });

  it('subtracts debt at the region rate', () => {
    expect(creditBalanceValue({ lots: [], debtMicrocredits: 5_000_000_000n, reservedMicrocredits: 0n,
      target: europe('1.25') })).toEqual({ currency: 'EUR', amount: '-4.00', amountMinor: -400n });
  });

  it('values one usage line from the lots it drew', () => {
    // 3,000 credits from the USD lot and 2,000 from the EUR lot.
    expect(creditMovementValue([
      { deltaMicrocredits: -3_000_000_000n, lot: usdLot },
      { deltaMicrocredits: -2_000_000_000n, lot: eurLot },
    ], europe('1.25'))).toEqual({ currency: 'EUR', amount: '4.12', amountMinor: 412n });
  });
});
