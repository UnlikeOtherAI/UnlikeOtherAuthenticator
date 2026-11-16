import { describe, expect, it } from 'vitest';

import {
  billingActor,
  billingDate,
  billingDateTime,
  billingLabel,
  billingMonth,
  billingMonthIsFuture,
  billingMonthStart,
  billingTariffName,
  billingTariffSummary,
  billingUtcDate,
  nextBillingMonth,
} from './billing-format';

type Terms = Parameters<typeof billingTariffSummary>[0];

const terms = (overrides: Partial<Terms> = {}): Terms => ({
  mode: 'standard',
  collection_mode: 'stripe',
  markup_bps: 3000,
  usage_payment_mode: 'prepaid',
  monthly_subscription: {
    amount_minor: '399', currency: 'USD', charge_basis: 'per_seat',
    seat_policy: 'automatic', seat_charge_timing: 'prorated',
  },
  ...overrides,
});

describe('billing presentation', () => {
  it('summarises what a customer pays in one line', () => {
    expect(billingTariffSummary(terms()))
      .toBe('3.99 USD per seat · usage +30%, prepaid · card (Stripe)');
    expect(billingTariffSummary(terms({
      mode: 'free', collection_mode: 'none', markup_bps: 0,
      monthly_subscription: { amount_minor: '0', currency: 'USD', charge_basis: 'flat',
        seat_policy: null, seat_charge_timing: null },
    }))).toBe('No monthly fee · usage free · not collected');
    expect(billingTariffSummary(terms({
      mode: 'at_cost', collection_mode: 'manual', markup_bps: 0,
      usage_payment_mode: 'pay_as_you_go',
      monthly_subscription: { amount_minor: '50000', currency: 'USD', charge_basis: 'flat',
        seat_policy: null, seat_charge_timing: null },
    }))).toBe('500.00 USD per month · usage at cost, pay as you go · invoice');
    expect(billingTariffSummary(terms({ markup_bps: 1250 })))
      .toContain('usage +12.5%, prepaid');
  });

  it('formats every date one way and never shows a raw ISO string', () => {
    const instant = '2026-11-16T18:50:00.000Z';
    expect(billingDate(instant)).toMatch(/^1[67] Nov 2026$/);
    expect(billingDateTime(instant)).toMatch(/^1[67] Nov 2026, \d{2}:\d{2}$/);
    expect(billingUtcDate('2026-12-01T00:00:00.000Z')).toBe('1 Dec 2026');
    for (const missing of [null, undefined, '', 'not a date']) {
      expect(billingDate(missing)).toBe('—');
      expect(billingDateTime(missing)).toBe('—');
      expect(billingUtcDate(missing)).toBe('—');
    }
  });

  it('names billing months the way the API counts them, in UTC', () => {
    const lateOnTheLastDay = new Date('2026-11-30T23:30:00.000Z');
    expect(billingMonth(lateOnTheLastDay)).toBe('2026-11');
    expect(nextBillingMonth(lateOnTheLastDay)).toBe('2026-12');
    expect(nextBillingMonth(new Date('2026-12-15T00:00:00.000Z'))).toBe('2027-01');
    expect(billingMonthStart('2026-12')).toBe('1 December 2026');
    expect(billingMonthIsFuture('2026-12', lateOnTheLastDay)).toBe(true);
    expect(billingMonthIsFuture('2026-11', lateOnTheLastDay)).toBe(false);
    expect(billingMonthIsFuture(null, lateOnTheLastDay)).toBe(false);
  });

  it('shows identifiers as sentence-case words, people as themselves and jobs as System', () => {
    expect(billingLabel('pay_as_you_go')).toBe('Pay as you go');
    expect(billingLabel('past_due')).toBe('Past due');
    expect(billingLabel('')).toBe('—');
    expect(billingActor('operator@example.com')).toBe('operator@example.com');
    expect(billingActor('system:seed')).toBe('System');
    expect(billingActor(null)).toBe('—');
    expect(billingTariffName({ name: 'Free', key: 'free', version: 2 })).toBe('Free · free v2');
  });
});
