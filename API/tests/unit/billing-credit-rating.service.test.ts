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
    billingDisposition: 'paid',
    billingProduct: product,
    callerProduct: product,
    originProduct: product,
    userId,
  };
}

function portfolio(lines: NormalizedMeteringPortfolio['lines']): NormalizedMeteringPortfolio {
  return {
    schemaVersion: 1,
    billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
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
  it('assigns a scarce remainder credit by stable binary identity order without losing liability', () => {
    const users = ['a', 'A', 'ä'];
    const rate = (order: string[]) => rateCreditPortfolio({
      portfolio: portfolio(order.map((user) => line('deepwater', user, '0.001'))),
      services: [deepwater], previousAllocations: [], balanceMicrocredits: 1_000_000n,
      validTeamUserIds: new Set(users),
    });
    const first = rate(users);
    expect(rate([...users].reverse())).toEqual(first);
    expect(first[0]?.consumedMicrocredits).toBe(1_000_000n);
    expect(first[0]?.remainingMicroMinor).toBe(200_000n);
    expect(first[0]?.allocations.find((item) => item.consumedMicrocredits > 0n)?.userId).toBe('A');
    expect(first[0]?.allocations.map((item) => item.userId)).toEqual(['A', 'a', 'ä']);
  });

  it('charges 1560 credits for $1.20 provider cost at the central 30% rate', () => {
    const [result] = rateCreditPortfolio({
      portfolio: portfolio([line('deepwater', 'user_1', '1.20')]),
      services: [{ ...deepwater, tariff: { ...deepwater.tariff, markupBps: 3000 } }],
      previousAllocations: [],
      balanceMicrocredits: 2_000_000_000n,
      validTeamUserIds: new Set(['user_1']),
    });
    expect(result.ratedMicroMinor).toBe(156_000_000n);
    expect(result.consumedMicrocredits).toBe(1_560_000_000n);
  });
  it('caps a later top-up at the new usage not already reserved by Stripe', () => {
    const [result] = rateCreditPortfolio({
      portfolio: portfolio([line('deepwater', 'user_1', '1')]),
      services: [deepwater],
      previousAllocations: [],
      balanceMicrocredits: 1_300_000_000n,
      validTeamUserIds: new Set(['user_1']),
      maxAdditionalCreditsByService: new Map([[deepwater.id, 0n]]),
    });
    expect(result).toMatchObject({
      ratedMicroMinor: 100_000_000n,
      consumedMicrocredits: 0n,
      remainingMicroMinor: 100_000_000n,
    });
    const [later] = rateCreditPortfolio({
      portfolio: portfolio([line('deepwater', 'user_1', '2')]),
      services: [deepwater],
      previousAllocations: [],
      balanceMicrocredits: 2_000_000_000n,
      validTeamUserIds: new Set(['user_1']),
      maxAdditionalCreditsByService: new Map([[deepwater.id, 1_000n]]),
    });
    expect(later).toMatchObject({
      ratedMicroMinor: 200_000_000n,
      consumedMicrocredits: 1_000_000_000n,
      remainingMicroMinor: 100_000_000n,
    });
  });

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

  it('floors rated usage to whole credits and carries the fractional remainder forward', () => {
    const [result] = rateCreditPortfolio({
      portfolio: portfolio([line('deepwater', 'user_1', '0.00108365')]),
      services: [deepwater],
      previousAllocations: [],
      balanceMicrocredits: 50_000_000_000n,
      validTeamUserIds: new Set(['user_1']),
    });

    expect(result).toMatchObject({
      ratedMicroMinor: 108_365n,
      consumedMicrocredits: 1_000_000n,
      remainingMicroMinor: 8_365n,
    });
    expect(result.allocations).toEqual([
      expect.objectContaining({
        userId: 'user_1',
        consumedMicrocredits: 1_000_000n,
        remainingMicroMinor: 8_365n,
      }),
    ]);
  });

  it('does not debit a fractional credit before that user and service reach one full credit', () => {
    const [result] = rateCreditPortfolio({
      portfolio: portfolio([line('deepwater', 'user_1', '0.00099999')]),
      services: [deepwater],
      previousAllocations: [],
      balanceMicrocredits: 50_000_000_000n,
      validTeamUserIds: new Set(['user_1']),
    });

    expect(result).toMatchObject({
      ratedMicroMinor: 99_999n,
      consumedMicrocredits: 0n,
      remainingMicroMinor: 99_999n,
    });
  });

  it('normalizes a historical fractional debit to the whole-credit rule', () => {
    const [result] = rateCreditPortfolio({
      portfolio: portfolio([line('deepwater', 'user_1', '0.00108365')]),
      services: [deepwater],
      previousAllocations: [
        {
          serviceId: deepwater.id,
          userId: 'user_1',
          consumedMicrocredits: 1_083_650n,
        },
      ],
      balanceMicrocredits: 49_998_916_350n,
      validTeamUserIds: new Set(['user_1']),
    });

    expect(result).toMatchObject({
      consumedMicrocredits: 1_000_000n,
      remainingMicroMinor: 8_365n,
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

  it('holds an unresolved paid attempt before debiting any credit', () => {
    const evidence = portfolio([line('deepwater', 'user_1', '1')]);
    evidence.billingCompleteness = { state: 'unresolved', unresolvedPaidAttempts: '1' };
    expect(() => rateCreditPortfolio({
      portfolio: evidence,
      services: [deepwater],
      previousAllocations: [],
      balanceMicrocredits: 1_000_000_000n,
      validTeamUserIds: new Set(['user_1']),
    })).toThrow('LEDGER_METERING_UNRESOLVED_PAID_USAGE');
  });
});

function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}
