import {
  BillingProviderServiceLineKind, BillingTariffMode, BillingUsagePaymentMode, type BillingTariff,
} from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  aggregateOrganisationCycleUsage, cycleUsageLineKind, projectCycleUsage, withCycleLineCredits,
} from '../../src/services/billing-cycle-usage-projection.service.js';
import { localizeBillingCycleDetail } from '../../src/services/billing-cycle-display.service.js';
import type { NormalizedMeteringUsage, RawMeteringLine } from '../../src/services/billing-metering.types.js';
import {
  effectiveMarkupBps, normalizeProviderServiceRates, providerServiceLineKind,
  type ProviderServiceRate,
} from '../../src/services/billing-provider-service-rate.service.js';
import { rateBillingStatementUsage } from '../../src/services/billing-statement-rating.service.js';
import type { BillingCycleDetailV2 } from '../../src/contracts/billing-statement-v1.js';

const rates: ProviderServiceRate[] = [
  { providerServiceId: 'browserbase', markupBps: 2000, lineKind: 'cloud_browser' },
];
const prepaidStandard = { mode: BillingTariffMode.STANDARD, usagePaymentMode: BillingUsagePaymentMode.PREPAID };

function line(serviceId: string, cost: string, extra: Partial<RawMeteringLine> = {}): RawMeteringLine {
  return { serviceId, usageUnit: serviceId === 'browserbase' ? 'minutes' : 'tokens', calls: '1',
    inputUnits: '3', cachedInputUnits: '0', outputUnits: '0', estimatedProviderCost: cost,
    actualProviderCost: cost, selectedProviderCost: cost, currency: 'USD', costProvenance: 'provider_actual',
    billingProduct: 'salesnerd', callerProduct: 'salesnerd', originProduct: 'salesnerd',
    userId: 'person-1', billingDisposition: 'paid', ...extra };
}

const startsAt = new Date('2026-10-01T00:00:00.000Z');
const endsAt = new Date('2026-11-01T00:00:00.000Z');
function metering(lines: RawMeteringLine[]): NormalizedMeteringUsage {
  return { schemaVersion: 1, product: 'salesnerd', groupBy: 'user', calls: String(lines.length),
    scope: { organizationId: 'org-1', teamId: 'team-1', userId: null, month: '2026-10',
      startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
    billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
    snapshot: { id: 'snapshot-1', cursor: 'cursor-1', sha256: 'hash-1',
      capturedAt: '2026-11-01T00:01:00.000Z', immutable: true }, lines };
}

describe('connected provider-service rates', () => {
  it('accepts rates only on prepaid standard or custom tariff versions', () => {
    expect(normalizeProviderServiceRates([{ providerServiceId: ' Browserbase ', markupBps: 2000,
      lineKind: 'cloud_browser' }], prepaidStandard)).toEqual([{ providerServiceId: 'browserbase',
      markupBps: 2000, lineKind: BillingProviderServiceLineKind.CLOUD_BROWSER }]);
    expect(normalizeProviderServiceRates(undefined, { ...prepaidStandard,
      usagePaymentMode: BillingUsagePaymentMode.PAY_AS_YOU_GO })).toEqual([]);
    expect(() => normalizeProviderServiceRates(rates, { ...prepaidStandard,
      usagePaymentMode: BillingUsagePaymentMode.PAY_AS_YOU_GO })).toThrow('BILLING_PROVIDER_SERVICE_RATES_REQUIRE_PREPAID');
    expect(() => normalizeProviderServiceRates(rates, { ...prepaidStandard, mode: BillingTariffMode.AT_COST }))
      .toThrow('BILLING_PROVIDER_SERVICE_RATES_REQUIRE_PREPAID');
    expect(() => normalizeProviderServiceRates([...rates, ...rates], prepaidStandard)).toThrow('INVALID_PROVIDER_SERVICE_RATES');
    expect(() => normalizeProviderServiceRates([{ ...rates[0]!, markupBps: 100_001 }], prepaidStandard))
      .toThrow('INVALID_PROVIDER_SERVICE_RATES');
    expect(() => normalizeProviderServiceRates([{ ...rates[0]!, providerServiceId: 'not a service' }], prepaidStandard))
      .toThrow('INVALID_PROVIDER_SERVICE_RATES');
  });

  it('rates the connector with its own markup and everything else with the tariff', () => {
    expect(effectiveMarkupBps({ markupBps: 3000 }, rates, 'browserbase')).toBe(2000);
    expect(effectiveMarkupBps({ markupBps: 3000 }, rates, 'openai')).toBe(3000);
    expect(providerServiceLineKind(rates, 'browserbase')).toBe('cloud_browser');
    expect(providerServiceLineKind(rates, 'openai')).toBeNull();
  });

  it('shows cloud browser usage as its own statement line at 20 percent over provider cost', () => {
    const usage = metering([line('openai', '1'), line('browserbase', '0.006')]);
    const rated = rateBillingStatementUsage({ serviceMetering: usage, userMetering: usage,
      plan: { product: 'salesnerd', mode: 'standard', markupBps: 3000, providerServiceRates: rates },
      users: [{ id: 'person-1', name: 'Person', email: 'person@example.com' }] });
    expect(rated.usage.lines.map((item) => item.customer_charge?.amount)).toEqual(['1.3', '0.0072']);
    expect(rated.commercialLines).toEqual([
      expect.objectContaining({ id: 'usage_USD', kind: 'usage', label: 'Metered usage',
        amount: expect.objectContaining({ amount: '1.3' }) as unknown }),
      expect.objectContaining({ id: 'usage_cloud_browser_USD', kind: 'usage', label: 'Cloud browser',
        detail: 'Cloud browser charge for this billing period',
        amount: expect.objectContaining({ amount: '0.0072' }) as unknown }),
    ]);
    const visible = JSON.stringify(rated);
    for (const forbidden of ['markup', '2000', 'provider_cost', '0.006"']) expect(visible).not.toContain(forbidden);
  });

  it('keeps one unchanged usage line for a tariff without connected rates', () => {
    const usage = metering([line('openai', '1'), line('browserbase', '0.006')]);
    const rated = rateBillingStatementUsage({ serviceMetering: usage, userMetering: usage,
      plan: { product: 'salesnerd', mode: 'standard', markupBps: 2000 }, users: [] });
    expect(rated.commercialLines).toEqual([expect.objectContaining({ id: 'usage_USD', label: 'Metered usage',
      amount: expect.objectContaining({ amount: '1.2072' }) as unknown })]);
  });

  it('splits a prepaid cycle into product and cloud browser lines with exact credits', () => {
    const tariff = { mode: 'STANDARD', markupBps: 3000, usagePaymentMode: BillingUsagePaymentMode.PREPAID } as BillingTariff;
    const expected = { serviceIdentifier: 'salesnerd', organisationId: 'org-1', teamId: 'team-1',
      billingMonth: '2026-10', currency: 'USD', startsAt, endsAt };
    const projected = projectCycleUsage(metering([line('openai', '1'), line('browserbase', '0.006')]),
      expected, tariff, rates);
    expect(projected.ratedAmount).toBe('1.3072');
    expect(projected.lines.map((item) => [item.label, cycleUsageLineKind(item), item.customer_charge]))
      .toEqual([['Metered usage', null, null], ['Cloud browser', 'cloud_browser', null]]);
    const credited = withCycleLineCredits(projected.lines, 1_307_200_000n, new Map([['cloud_browser', 7_200_000n]]));
    expect(credited.map((item) => item.credits_consumed)).toEqual(['1300', '7.2']);
    expect(() => withCycleLineCredits(projected.lines, 1n, new Map([['cloud_browser', 7_200_000n]])))
      .toThrow();
    expect(() => projectCycleUsage(metering([line('browserbase', '0.006')]), expected,
      { ...tariff, usagePaymentMode: BillingUsagePaymentMode.PAY_AS_YOU_GO }, rates)).toThrow();
    const unchanged = projectCycleUsage(metering([line('openai', '1'), line('browserbase', '0.006')]), expected, tariff);
    expect(unchanged.lines).toHaveLength(1);
    expect(withCycleLineCredits(unchanged.lines, 5n, new Map())[0]?.credits_consumed).toBe('0.000005');
  });

  it('keeps cloud browser lines separate in organisation cycles and localizes them', () => {
    const lines = aggregateOrganisationCycleUsage([
      { id: 'usage:aaa', label: 'Metered usage', usage_payment_mode: 'prepaid', customer_charge: null, credits_consumed: '10' },
      { id: 'usage:cloud_browser:bbb', label: 'Cloud browser', usage_payment_mode: 'prepaid', customer_charge: null, credits_consumed: '2' },
      { id: 'usage:cloud_browser:ccc', label: 'Cloud browser', usage_payment_mode: 'prepaid', customer_charge: null, credits_consumed: '3' },
    ]);
    expect(lines.map((item) => [item.id, item.label, item.credits_consumed])).toEqual([
      ['usage:organisation:prepaid', 'Prepaid usage', '10'],
      ['usage:organisation:prepaid:cloud_browser', 'Cloud browser', '5'],
    ]);
    const detail = { totals: [], subscription_lines: [], usage_lines: lines, documents: [], adjustments: [] } as unknown as BillingCycleDetailV2;
    expect(localizeBillingCycleDetail(detail, 'cs').usage_lines.map((item) => item.label))
      .toEqual(['Předplacená spotřeba', 'Cloudový prohlížeč']);
  });
});
