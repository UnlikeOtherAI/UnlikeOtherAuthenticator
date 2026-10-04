import { BillingUsagePaymentMode, type BillingTariff } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  aggregateOrganisationCycleUsage, projectCycleUsage,
} from '../../src/services/billing-cycle-usage-projection.service.js';
import type { NormalizedMeteringUsage } from '../../src/services/billing-metering.types.js';

const expected = { serviceIdentifier: 'nessie', organisationId: 'org-1',
  teamId: 'team-1', billingMonth: '2026-09', currency: 'USD',
  startsAt: new Date('2026-09-01T00:00:00.000Z'),
  endsAt: new Date('2026-10-01T00:00:00.000Z') };

function metering(): NormalizedMeteringUsage {
  return { schemaVersion: 1, product: 'nessie', groupBy: 'user', calls: '1',
    scope: { organizationId: 'org-1', teamId: 'team-1', userId: null,
      month: '2026-09', startsAt: expected.startsAt.toISOString(),
      endsAt: expected.endsAt.toISOString() },
    billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
    snapshot: { id: 'snapshot-1', cursor: 'cursor-1', sha256: 'hash-1',
      capturedAt: '2026-10-01T00:01:00.000Z', immutable: true },
    lines: [{ serviceId: 'model-1', usageUnit: 'tokens', calls: '1', inputUnits: '1',
      cachedInputUnits: '0', outputUnits: '1', estimatedProviderCost: '10',
      actualProviderCost: '10', selectedProviderCost: '10', currency: 'USD',
      costProvenance: 'actual', billingProduct: 'nessie', callerProduct: 'nessie',
      originProduct: 'nessie', userId: 'person-1', billingDisposition: 'paid' }] };
}

describe('customer cycle usage payment mode', () => {
  it('keeps the private 30 percent rated amount while prepaid has no new invoice charge', () => {
    const tariff = { mode: 'STANDARD', markupBps: 3000,
      usagePaymentMode: BillingUsagePaymentMode.PREPAID } as BillingTariff;
    const prepaid = projectCycleUsage(metering(), expected, tariff);
    expect(prepaid.ratedAmount).toBe('13');
    expect(prepaid.lines).toEqual([expect.objectContaining({
      usage_payment_mode: 'prepaid', customer_charge: null,
    })]);
    const payg = projectCycleUsage(metering(), expected, {
      ...tariff, usagePaymentMode: BillingUsagePaymentMode.PAY_AS_YOU_GO,
    });
    expect(payg.ratedAmount).toBe('13');
    expect(payg.lines[0]).toEqual(expect.objectContaining({
      usage_payment_mode: 'pay_as_you_go',
      customer_charge: expect.objectContaining({ amount: '13' }),
    }));
  });

  it('keeps org payable and prepaid credit evidence in separate customer lines', () => {
    const projected = aggregateOrganisationCycleUsage([
      { id: 'payg-a', label: 'Metered usage', usage_payment_mode: 'pay_as_you_go',
        customer_charge: { amount: '1', currency: 'USD', display: '$1.00' },
        credits_consumed: '1000.000001' },
      { id: 'prepaid-b', label: 'Metered usage', usage_payment_mode: 'prepaid',
        customer_charge: null, credits_consumed: '2000.000002' },
      { id: 'prepaid-c', label: 'Metered usage', usage_payment_mode: 'prepaid',
        customer_charge: null, credits_consumed: '0.000003' },
    ]);
    expect(projected).toMatchObject([
      { usage_payment_mode: 'pay_as_you_go', credits_consumed: '1000.000001',
        customer_charge: { amount: '1' } },
      { usage_payment_mode: 'prepaid', credits_consumed: '2000.000005',
        customer_charge: null },
    ]);
    expect(aggregateOrganisationCycleUsage([
      { id: 'payg-a', label: 'Metered usage', usage_payment_mode: 'pay_as_you_go',
        customer_charge: { amount: '1', currency: 'USD', display: '$1.00' },
        credits_consumed: '1000' },
      { id: 'prepaid-b', label: 'Metered usage', usage_payment_mode: 'prepaid',
        customer_charge: null, credits_consumed: null },
    ])[1]?.credits_consumed).toBeNull();
  });
});
