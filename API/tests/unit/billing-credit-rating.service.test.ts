import { BillingTariffMode } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  rateCreditPortfolio,
  type CreditRatingService,
} from '../../src/services/billing-credit-rating.service.js';
import type { NormalizedMeteringPortfolio } from '../../src/services/billing-metering.types.js';

const deepwater: CreditRatingService = {
  id: 'service_deepwater',
  identifier: 'deepwater',
  name: 'DeepWater',
  tariff: {
    id: 'tariff_deepwater',
    mode: BillingTariffMode.STANDARD,
    markupBps: 0,
    currency: 'USD',
  },
};
const nessie: CreditRatingService = {
  id: 'service_nessie',
  identifier: 'nessie',
  name: 'Nessie',
  tariff: {
    id: 'tariff_nessie',
    mode: BillingTariffMode.STANDARD,
    markupBps: 0,
    currency: 'USD',
  },
};

function line(product: string, userId: string | null, cost: string) {
  return {
    serviceId: 'provider_openai',
    usageUnit: 'tokens',
    calls: '1',
    inputUnits: '0',
    cachedInputUnits: '0',
    outputUnits: '0',
    estimatedProviderCost: cost,
    actualProviderCost: cost,
    selectedProviderCost: cost,
    currency: 'USD',
    costProvenance: 'actual',
    billingProduct: product,
    callerProduct: product,
    originProduct: product,
    userId,
  };
}

function portfolio(lines: NormalizedMeteringPortfolio['lines']): NormalizedMeteringPortfolio {
  return {
    schemaVersion: 1,
    contract: 'metering-portfolio-v1',
    perspectiveProduct: 'deepwater',
    groupBy: 'user',
    scope: {
      organizationId: 'org_1',
      teamId: 'team_1',
      month: '2026-07',
      startsAt: '2026-07-01T00:00:00.000Z',
      endsAt: '2026-08-01T00:00:00.000Z',
    },
    calls: '2',
    lines,
    snapshot: {
      id: 'snapshot_1',
      cursor: 'cursor_1',
      capturedAt: '2026-07-21T12:00:00.000Z',
      immutable: true,
      sha256: 'a'.repeat(64),
    },
  };
}

describe('canonical all-service credit rating', () => {
  it('records the full rated liability while scarce credits stop exactly at zero', () => {
    const result = rateCreditPortfolio({
      portfolio: portfolio([line('deepwater', 'user_1', '1'), line('nessie', null, '1')]),
      services: [deepwater, nessie],
      previousAllocations: [],
      balanceMicrocredits: 750_000_000n,
      validTeamUserIds: new Set(['user_1']),
    });

    expect(result).toEqual([
      expect.objectContaining({
        service: deepwater,
        ratedMicroMinor: 100_000_000n,
        consumedMicrocredits: 375_000_000n,
        remainingMicroMinor: 62_500_000n,
      }),
      expect.objectContaining({
        service: nessie,
        ratedMicroMinor: 100_000_000n,
        consumedMicrocredits: 375_000_000n,
        remainingMicroMinor: 62_500_000n,
      }),
    ]);
    expect(sum(result.map((row) => row.consumedMicrocredits))).toBe(750_000_000n);
    expect(sum(result.map((row) => row.ratedMicroMinor)) * 10n).toBe(
      sum(result.map((row) => row.consumedMicrocredits)) +
        sum(result.map((row) => row.remainingMicroMinor)) * 10n,
    );
  });

  it('does not let usage deepen verified refund or dispute debt', () => {
    const [result] = rateCreditPortfolio({
      portfolio: portfolio([line('deepwater', 'user_1', '1')]),
      services: [deepwater],
      previousAllocations: [],
      balanceMicrocredits: -100_000_000n,
      validTeamUserIds: new Set(['user_1']),
    });

    expect(result).toMatchObject({
      ratedMicroMinor: 100_000_000n,
      consumedMicrocredits: 0n,
      remainingMicroMinor: 100_000_000n,
    });
  });

  it('releases credits deterministically when a corrected snapshot is lower', () => {
    const [result] = rateCreditPortfolio({
      portfolio: portfolio([line('deepwater', 'user_1', '0.2')]),
      services: [deepwater],
      previousAllocations: [
        {
          serviceId: deepwater.id,
          userId: 'user_1',
          consumedMicrocredits: 800_000_000n,
        },
      ],
      balanceMicrocredits: 0n,
      validTeamUserIds: new Set(['user_1']),
    });

    expect(result).toMatchObject({
      ratedMicroMinor: 20_000_000n,
      consumedMicrocredits: 200_000_000n,
      remainingMicroMinor: 0n,
    });
  });

  it('reallocates the same aggregate cursor total between exact-team users', () => {
    const [result] = rateCreditPortfolio({
      portfolio: portfolio([line('deepwater', 'user_2', '1')]),
      services: [deepwater],
      previousAllocations: [
        {
          serviceId: deepwater.id,
          userId: 'user_1',
          consumedMicrocredits: 1_000_000_000n,
        },
      ],
      balanceMicrocredits: 0n,
      validTeamUserIds: new Set(['user_1', 'user_2']),
    });

    expect(result.consumedMicrocredits).toBe(1_000_000_000n);
    expect(result.allocations).toEqual([
      expect.objectContaining({ userId: 'user_1', consumedMicrocredits: 0n }),
      expect.objectContaining({ userId: 'user_2', consumedMicrocredits: 1_000_000_000n }),
    ]);
  });

  it('fails closed for a non-null user outside the exact team', () => {
    expect(() =>
      rateCreditPortfolio({
        portfolio: portfolio([line('deepwater', 'user_unknown', '1')]),
        services: [deepwater],
        previousAllocations: [],
        balanceMicrocredits: 1_000_000_000n,
        validTeamUserIds: new Set(['user_1']),
      }),
    ).toThrow('LEDGER_CREDIT_USER_INVALID');
  });
});

function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}
