import { describe, expect, it } from 'vitest';

import { ApiRequestError } from '../../services/api-client';
import {
  billingActor,
  billingDate,
  billingDateTime,
  billingLabel,
  billingMonth,
  billingMonthIsFuture,
  billingMonthStart,
  billingRefusal,
  billingTariffLabel,
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

describe('billingTariffLabel', () => {
  const tariff = (id: string, name: string, version = 1, retired_at: string | null = null) =>
    ({ id, name, key: name.toLowerCase(), version, retired_at });
  const standard = tariff('s1', 'Standard');

  it('is the name alone while no other active tariff of the product shares it', () => {
    expect(billingTariffLabel(standard, [standard, tariff('f1', 'Free')])).toBe('Standard');
    expect(billingTariffLabel(standard, [standard, tariff('s0', 'Standard', 0, '2026-09-01T00:00:00.000Z')]))
      .toBe('Standard');
  });

  it('adds the key and version when another active tariff has the same name', () => {
    expect(billingTariffLabel(standard, [standard, tariff('s2', 'Standard', 2)])).toBe('Standard · standard v1');
  });
});

describe('billingRefusal', () => {
  it('gives a recovery step when the save response cannot be read', () => {
    expect(billingRefusal(new SyntaxError('Unexpected token in JSON')))
      .toBe('We could not confirm the change. Refresh to check whether it was saved.');
  });

  it('says why a tariff change was refused, in plain words', () => {
    const refused = (code?: string) => billingRefusal(new ApiRequestError(409, code));
    expect(refused('BILLING_TARIFF_RETIRED')).toBe('This tariff is retired. Pick another one.');
    expect(refused('BILLING_TARIFF_IN_USE')).toBe('Somebody is still on this tariff. Move them first.');
    expect(refused('STRIPE_TARIFF_PINNED'))
      .toBe('An active Stripe subscription keeps the current tariff until it ends.');
    expect(refused('BILLING_CONTRACT_ASSIGNMENT_LOCKED'))
      .toBe('A contract sets this tariff. Change the contract instead.');
    expect(refused('INVALID_TARIFF_ASSIGNMENT')).toBe('This tariff cannot be assigned here.');
    expect(refused('SOMETHING_NEW')).toBe('The change was refused (SOMETHING_NEW).');
    expect(billingRefusal(new ApiRequestError(503))).toBe('The change was refused (HTTP 503).');
  });
});
