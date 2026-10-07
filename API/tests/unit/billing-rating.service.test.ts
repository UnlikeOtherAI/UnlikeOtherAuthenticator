import { describe, expect, it } from 'vitest';

import type { NormalizedMeteringUsage } from '../../src/services/billing-metering.types.js';
import {
  rateMeteringByCaller,
  rateMeteringTotal,
  rateProviderCost,
  usagePriceMultiplierBps,
} from '../../src/services/billing-rating.service.js';

function metering(): NormalizedMeteringUsage {
  return {
    schemaVersion: 1,
    billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
    product: 'deepwater',
    groupBy: 'service',
    scope: {
      organizationId: 'org_1',
      teamId: null,
      userId: null,
      month: '2026-06',
      startsAt: '2026-06-01T00:00:00.000Z',
      endsAt: '2026-07-01T00:00:00.000Z',
    },
    calls: '3',
    lines: [
      {
        serviceId: 'openai',
        usageUnit: 'tokens',
        calls: '2',
        inputUnits: '100',
        cachedInputUnits: '0',
        outputUnits: '25',
        estimatedProviderCost: null,
        actualProviderCost: '1.111111',
        selectedProviderCost: '1.111111',
        currency: 'USD',
        costProvenance: 'provider_invoice',
        billingDisposition: 'paid',
        billingProduct: 'deepwater',
        callerProduct: 'nessie',
        originProduct: 'nessie',
        userId: null,
      },
      {
        serviceId: 'serper',
        usageUnit: 'requests',
        calls: '1',
        inputUnits: '1',
        cachedInputUnits: '0',
        outputUnits: '0',
        estimatedProviderCost: '0.222222',
        actualProviderCost: null,
        selectedProviderCost: '0.222222',
        currency: 'USD',
        costProvenance: 'provider_pricebook',
        billingDisposition: 'paid',
        billingProduct: 'deepwater',
        callerProduct: null,
        originProduct: 'deepwater',
        userId: null,
      },
    ],
    snapshot: {
      cursor: 'mus_0123456789ABCDEFGHIJKLMNOPQRSTUV',
      id: 'mus_0123456789ABCDEFGHIJKLMNOPQRSTUV',
      capturedAt: '2026-07-02T12:00:00.000Z',
      immutable: true,
      sha256: 'a'.repeat(64),
    },
  };
}

describe('shared billing rating core', () => {
  it('uses one exact markup formula for statement, Stripe, and contract invoice callers', () => {
    const terms = { mode: 'custom' as const, markupBps: 2_500 };

    expect(usagePriceMultiplierBps(terms)).toBe(12_500);
    expect(rateProviderCost('1.333333', 'USD', terms)).toEqual({
      base: '1.333333',
      markup: '0.33333325',
      total: '1.66666625',
      currency: 'USD',
    });
    expect(
      rateMeteringTotal({
        usage: metering(),
        product: 'deepwater',
        currency: 'USD',
        terms,
      }),
    ).toEqual({
      base: '1.333333',
      markup: '0.33333325',
      total: '1.66666625',
      currency: 'USD',
    });
    expect(
      rateMeteringByCaller({
        usage: metering(),
        product: 'deepwater',
        currency: 'USD',
        terms,
        unattributedCaller: 'unattributed',
      }),
    ).toEqual([
      {
        billingProduct: 'deepwater',
        callerProduct: 'nessie',
        base: '1.111111',
        markup: '0.27777775',
        total: '1.38888875',
        currency: 'USD',
      },
      {
        billingProduct: 'deepwater',
        callerProduct: 'unattributed',
        base: '0.222222',
        markup: '0.0555555',
        total: '0.2777775',
        currency: 'USD',
      },
    ]);
  });

  it('fails closed for wrong products, currencies, and missing selected cost', () => {
    const usage = metering();
    expect(() =>
      rateMeteringTotal({
        usage,
        product: 'nessie',
        currency: 'USD',
        terms: { mode: 'custom', markupBps: 0 },
      }),
    ).toThrow('LEDGER_METERING_PRODUCT_MISMATCH');
    expect(() =>
      rateMeteringTotal({
        usage,
        product: 'deepwater',
        currency: 'GBP',
        terms: { mode: 'custom', markupBps: 0 },
      }),
    ).toThrow('LEDGER_METERING_COST_MISMATCH');
    usage.lines[0]!.selectedProviderCost = null;
    usage.lines[0]!.currency = null;
    expect(() =>
      rateMeteringTotal({
        usage,
        product: 'deepwater',
        currency: 'USD',
        terms: { mode: 'custom', markupBps: 0 },
      }),
    ).toThrow('LEDGER_METERING_COST_MISSING');
  });

  it('preserves free and at-cost semantics', () => {
    expect(rateProviderCost('5', 'GBP', { mode: 'free', markupBps: 0 })).toEqual({
      base: '0',
      markup: '0',
      total: '0',
      currency: 'GBP',
    });
    expect(rateProviderCost('5', 'GBP', { mode: 'at_cost', markupBps: 0 })).toEqual({
      base: '5',
      markup: '0',
      total: '5',
      currency: 'GBP',
    });
  });

  it('applies the central 30% once to exact provider costs', () => {
    expect(rateProviderCost('1.20', 'USD', { mode: 'standard', markupBps: 3000 })).toEqual({
      base: '1.20', markup: '0.36', total: '1.56', currency: 'USD',
    });
    expect(rateProviderCost('0.000001', 'USD', { mode: 'standard', markupBps: 3000 }))
      .toMatchObject({ total: '0.0000013' });
  });

  it('holds paid rows without cost and unresolved dispatches, but skips explicit nonbillable rows', () => {
    const usage = metering();
    usage.billingCompleteness = { state: 'unresolved', unresolvedPaidAttempts: '1' };
    expect(() => rateMeteringTotal({
      usage, product: 'deepwater', currency: 'USD', terms: { mode: 'standard', markupBps: 3000 },
    })).toThrow('LEDGER_METERING_UNRESOLVED_PAID_USAGE');
    usage.billingCompleteness = { state: 'complete', unresolvedPaidAttempts: '0' };
    usage.lines[0]!.selectedProviderCost = null;
    usage.lines[0]!.currency = null;
    expect(() => rateMeteringTotal({
      usage, product: 'deepwater', currency: 'USD', terms: { mode: 'standard', markupBps: 3000 },
    })).toThrow('LEDGER_METERING_COST_MISSING');
    usage.lines[0]!.billingDisposition = 'nonbillable';
    expect(rateMeteringTotal({
      usage, product: 'deepwater', currency: 'USD', terms: { mode: 'standard', markupBps: 3000 },
    }).total).toBe('0.2888886');
  });
});
