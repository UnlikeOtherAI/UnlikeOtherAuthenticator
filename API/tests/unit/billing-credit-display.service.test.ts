import { describe, expect, it } from 'vitest';

import {
  billingCreditAmount,
  billingCreditsPaymentMoney,
  billingRecurringAddonMoney,
  billingWholeCredits,
} from '../../src/services/billing-credit-display.service.js';

describe('customer credit display', () => {
  it('publishes only whole credits while retaining the whole-credit USD equivalent', () => {
    expect(billingCreditAmount(49_999_000_000n)).toEqual({
      credits: '49999',
      display: '49,999 credits',
      usd_equivalent: {
        amount: '49.999',
        currency: 'USD',
        display: 'US$50.00',
      },
    });
  });

  it('floors positive fractional credits and negative fractional balances', () => {
    expect(billingCreditAmount(1_083_650n)).toMatchObject({
      credits: '1',
      display: '1 credit',
      usd_equivalent: { amount: '0.001', display: 'US$0.00' },
    });
    expect(billingWholeCredits(-500_000n)).toBe(-1n);
    expect(billingCreditAmount(-500_000n)).toMatchObject({
      credits: '-1',
      display: '-1 credit',
    });
  });

  it('keeps payment amounts as ordinary two-decimal currency', () => {
    expect(billingCreditsPaymentMoney(5_000n)).toMatchObject({
      amount: '50',
      amount_minor: '5000',
      display: 'US$50.00',
    });
  });

  it.each([
    ['cs', 'US$50.00 / měsíc'],
    ['en-US', 'US$50.00 / month'],
    ['en-GB', 'US$50.00 / month'],
    ['de', 'US$50.00 / Monat'],
    ['es', 'US$50.00 / mes'],
    ['fr', 'US$50.00 / mois'],
    ['it', 'US$50.00 / mese'],
  ] as const)('localizes the recurring price period in %s', (locale, display) => {
    expect(billingRecurringAddonMoney(5_000n, 'USD', locale)).toMatchObject({
      amount_minor: '5000',
      display,
    });
  });
});
