import { describe, expect, it } from 'vitest';

import {
  billingCreditAmount,
  billingCreditsPaymentMoney,
  billingRecurringAddonMoney,
  billingWholeCredits,
} from '../../src/services/billing-credit-display.service.js';

describe('customer credit display', () => {
  it('publishes exact credit and USD-equivalent amounts', () => {
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

  it('retains positive and negative fractional credits', () => {
    expect(billingCreditAmount(1_083_650n)).toMatchObject({
      credits: '1.08365',
      display: '1.08365 credits',
      usd_equivalent: { amount: '0.00108365', display: 'US$0.00' },
    });
    expect(billingWholeCredits(-500_000n)).toBe(-1n);
    expect(billingCreditAmount(-500_000n)).toMatchObject({
      credits: '-0.5',
      display: '-0.5 credits',
      usd_equivalent: { amount: '-0.0005' },
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
    ['cs', '50,00\u00a0US$ / měsíc'],
    ['en-US', '$50.00 / month'],
    ['en-GB', 'US$50.00 / month'],
    ['de', '50,00\u00a0$ / Monat'],
    ['es', '50,00\u00a0US$ / mes'],
    ['fr', '50,00\u00a0$US / mois'],
    ['it', '50,00\u00a0USD / mese'],
  ] as const)('localizes the recurring price period in %s', (locale, display) => {
    expect(billingRecurringAddonMoney(5_000n, 'USD', locale)).toMatchObject({
      amount_minor: '5000',
      display,
    });
  });
});
