import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  billingCreditsV1ConformanceFixture,
  billingCreditsV1JsonSchema,
  type BillingCreditsManagerV1,
} from '../src/index.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateCredits = ajv.compile(billingCreditsV1JsonSchema);
const fixture = billingCreditsV1ConformanceFixture as BillingCreditsManagerV1;
const [usdOffer] = fixture.funding_policy.offers;

function withOffer(offer: Record<string, unknown>) {
  return { ...fixture, funding_policy: { ...fixture.funding_policy, offers: [{ ...usdOffer, ...offer }] } };
}

const eurOffer = {
  payment_amount: { amount: '25', amount_minor: '2500', currency: 'EUR', display: '€25.00' },
  credits_received: { credits: '29030', display: '29,030 credits',
    usd_equivalent: { amount: '29.03', currency: 'USD', display: 'US$29.03' } },
  credit_rate: { currency: 'EUR', usd_per_unit: '1.16123', source: 'stripe', as_of: '2026-10-12T12:00:00.000Z',
    display: 'At today\'s rate, 1 EUR = 1.1612 USD. Your credits are fixed when you start the payment.' },
};

describe('credits bought in the billing region currency (credits protocol 2.1.0)', () => {
  it('accepts a EUR or GBP offer with its live rate', () => {
    expect(validateCredits(withOffer(eurOffer)), JSON.stringify(validateCredits.errors)).toBe(true);
    expect(validateCredits(withOffer({ ...eurOffer,
      payment_amount: { ...eurOffer.payment_amount, currency: 'GBP', display: '£25.00' },
      credit_rate: { ...eurOffer.credit_rate, currency: 'GBP', source: 'ecb' } }))).toBe(true);
  });

  it('accepts a region-currency pending payment', () => {
    expect(validateCredits({ ...fixture, pending_credits: { ...fixture.pending_credits,
      payment_amount: { amount: '25', amount_minor: '2500', currency: 'EUR', display: '€25.00' } } })).toBe(true);
  });

  it.each([
    ['a currency credits are not sold in', { payment_amount: { ...eurOffer.payment_amount, currency: 'CHF' } }],
    ['a USD credit rate', { credit_rate: { ...eurOffer.credit_rate, currency: 'USD' } }],
    ['an unknown rate source', { credit_rate: { ...eurOffer.credit_rate, source: 'bank' } }],
    ['a zero rate', { credit_rate: { ...eurOffer.credit_rate, usd_per_unit: '0' } }],
    ['an extra rate field', { credit_rate: { ...eurOffer.credit_rate, quote_id: 'fxq_1' } }],
  ])('rejects %s', (_label, change) => {
    expect(validateCredits(withOffer({ ...eurOffer, ...change }))).toBe(false);
  });
});

describe('reload options in the billing region currency (credits protocol 2.2.0)', () => {
  const automatic = fixture.automatic_top_up;
  const [option] = automatic.options;
  const eur = (minor: string, display: string) => ({ amount: (Number(minor) / 100).toString(), amount_minor: minor,
    currency: 'EUR', display });

  it('accepts a EUR option and a EUR consented reload with their threshold values', () => {
    const eurOption = { ...option, threshold_value: eur('500', '€5.00'), refill_payment_amount: eur('2500', '€25.00'),
      monthly_cap: eur('10000', '€100.00'), credit_rate: eurOffer.credit_rate };
    expect(validateCredits({ ...fixture, automatic_top_up: { ...automatic, threshold_value: eur('500', '€5.00'),
      monthly_cap: eur('10000', '€100.00'), charged_this_month: eur('0', '€0.00'),
      remaining_monthly_cap: eur('10000', '€100.00'), options: [eurOption] } }),
    JSON.stringify(validateCredits.errors)).toBe(true);
  });

  it('rejects a reload in a currency credits are not sold in', () => {
    expect(validateCredits({ ...fixture, automatic_top_up: { ...automatic,
      options: [{ ...option, monthly_cap: { ...option.monthly_cap, currency: 'CHF' } }] } })).toBe(false);
  });
});


describe('credits valued in the billing region currency (credits protocol 2.3.0)', () => {
  const regionRate = { currency: 'EUR', usd_per_unit: '1.16123', credits_per_unit: '1161.23', source: 'purchase',
    as_of: '2026-10-12T12:00:00.000Z', display: '1 EUR ≈ 1,161 credits' };
  const value = { amount: '42.18', amount_minor: '4218', currency: 'EUR', display: '€42.18' };
  const [entry] = fixture.recent_entries;

  it('accepts the balance value, the price rate and entry values', () => {
    expect(validateCredits({ ...fixture, region_rate: regionRate,
      credit_balance: { ...fixture.credit_balance, value: { ...value, label: '€42.18 left' } },
      recent_entries: [{ ...entry, value }] }), JSON.stringify(validateCredits.errors)).toBe(true);
  });

  it('accepts a debt valued below zero, and values not known yet', () => {
    expect(validateCredits({ ...fixture, region_rate: null,
      credit_balance: { ...fixture.credit_balance, value: { amount: '-1.2', amount_minor: '-120', currency: 'EUR',
        display: '-€1.20', label: '€1.20 owed' } },
      recent_entries: [{ ...entry, value: null }] }), JSON.stringify(validateCredits.errors)).toBe(true);
    expect(validateCredits({ ...fixture, credit_balance: { ...fixture.credit_balance, value: null } })).toBe(true);
  });

  it.each([
    ['a balance value without its label', { credit_balance: { ...fixture.credit_balance, value } }],
    ['an unknown rate source', { region_rate: { ...regionRate, source: 'stripe' } }],
    ['a rate without credits per unit', { region_rate: { ...regionRate, credits_per_unit: undefined } }],
    ['a negative entry value', { recent_entries: [{ ...entry, value: { ...value, amount: '-1', amount_minor: '-100' } }] }],
    ['a value in a currency credits are not sold in', { recent_entries: [{ ...entry, value: { ...value,
      currency: 'CHF' } }] }],
  ])('rejects %s', (_label, change) => {
    expect(validateCredits(JSON.parse(JSON.stringify({ ...fixture, ...change })))).toBe(false);
  });
});
