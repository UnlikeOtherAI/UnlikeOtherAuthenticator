import { describe, expect, it } from 'vitest';
import type { EffectiveTariff } from '../../src/services/billing-tariff-history.service.js';
import { assertNessieUsageAdmission } from '../../src/services/billing-nessie-usage-admission.service.js';

function terms(overrides: Partial<EffectiveTariff['tariff']> = {},
  source: EffectiveTariff['source'] = 'SERVICE_DEFAULT'): EffectiveTariff {
  return { source, assignmentId: null, tariff: {
    mode: 'STANDARD', usagePaymentMode: 'PREPAID', collectionMode: 'STRIPE',
    monthlyChargeBasis: 'PER_SEAT', monthlyAmountMinor: 399n, seatPolicy: 'AUTOMATIC', seatChargeTiming: 'PRORATED', ...overrides,
  } as EffectiveTariff['tariff'] };
}

describe('Nessie paid usage admission', () => {
  it('refuses the deployed uncollected at-cost default before supplier dispatch', () => {
    expect(() => assertNessieUsageAdmission('nessie', terms({ mode: 'AT_COST',
      usagePaymentMode: 'PAY_AS_YOU_GO', collectionMode: 'NONE',
      monthlyChargeBasis: 'FLAT', monthlyAmountMinor: 0n })))
      .toThrow('NESSIE_PREPAID_SETUP_REQUIRED');
  });
  it.each(['SERVICE_DEFAULT', 'ORGANISATION', 'TEAM'] as const)(
    'refuses unfunded PAYG at %s scope', (source) => {
      expect(() => assertNessieUsageAdmission('nessie', terms({ usagePaymentMode: 'PAY_AS_YOU_GO' }, source)))
        .toThrow('NESSIE_PREPAID_SETUP_REQUIRED');
    });
  it('requires explicit assignment for free usage', () => {
    expect(() => assertNessieUsageAdmission('nessie', terms({ mode: 'FREE' })))
      .toThrow('NESSIE_PREPAID_SETUP_REQUIRED');
    for (const source of ['ORGANISATION', 'TEAM'] as const) {
      expect(() => assertNessieUsageAdmission('nessie', terms({ mode: 'FREE' }, source))).not.toThrow();
    }
  });
  it.each([
    { mode: 'AT_COST' }, { collectionMode: 'NONE' },
    { monthlyChargeBasis: 'FLAT' }, { monthlyAmountMinor: 0n },
  ] as Array<Partial<EffectiveTariff['tariff']>>)('rejects a nonregular default case %#', (change) => {
    expect(() => assertNessieUsageAdmission('nessie', terms(change)))
      .toThrow('NESSIE_PREPAID_SETUP_REQUIRED');
  });
  it('allows regular terms to proceed to the separate atomic balance reservation', () => {
    expect(() => assertNessieUsageAdmission('nessie', terms())).not.toThrow();
  });
  it('preserves explicitly assigned at-cost prepaid terms', () => {
    expect(() => assertNessieUsageAdmission('nessie', terms({ mode: 'AT_COST' }, 'ORGANISATION'))).not.toThrow();
  });
  it('does not change another product agreement', () => {
    expect(() => assertNessieUsageAdmission('deepwater', terms({ usagePaymentMode: 'PAY_AS_YOU_GO' }))).not.toThrow();
  });
});
