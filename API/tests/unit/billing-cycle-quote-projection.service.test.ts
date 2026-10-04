import {
  BillingAssignmentScope, BillingMonthlyChargeBasis, BillingSeatChargeTiming,
  BillingSeatPolicy,
} from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { projectMonthlySubscriptionLine } from '../../src/services/billing-cycle-quote-projection.service.js';
import type { quoteSubscriptionMonthlyCharge } from '../../src/services/billing-monthly-subscription-quote.service.js';

type MonthlyQuote = Awaited<ReturnType<typeof quoteSubscriptionMonthlyCharge>>;

describe('customer seat interval projection', () => {
  it('clips fixed capacity evidence to the exact commercial and termination window', () => {
    const quote: MonthlyQuote = {
      source: { kind: 'manual', id: 'term-1' }, serviceId: 'service-1', tariffId: 'tariff-1',
      organisationId: 'org-1', teamId: null, scope: BillingAssignmentScope.ORGANISATION,
      agreementId: 'agreement-1', billingMonth: '2026-09',
      chargeBasis: BillingMonthlyChargeBasis.PER_SEAT,
      seatPolicy: BillingSeatPolicy.FIXED,
      seatChargeTiming: BillingSeatChargeTiming.PRORATED,
      amountMinor: 1000n, unitAmountMinor: 2000n,
      uniqueHumanSeats: null, seatMilliseconds: 43_200_000n,
      monthMilliseconds: 2_592_000_000n, currency: 'USD',
      baselineCapturedAt: new Date('2026-08-01T00:00:00.000Z'),
      baselineMemberCount: 0,
      commercialEffectiveAt: new Date('2026-09-10T00:00:00.000Z'),
      commercialEndsAt: new Date('2026-09-25T00:00:00.000Z'),
      endedAt: new Date('2026-09-20T00:00:00.000Z'),
      intervals: [], capacityRevisions: [
        { id: 'baseline', quantity: 1, effectiveAt: new Date('2026-08-01T00:00:00.000Z') },
        { id: 'change', quantity: 2, effectiveAt: new Date('2026-09-15T00:00:00.000Z') },
      ], evidenceIds: ['baseline', 'change'],
    };
    const line = projectMonthlySubscriptionLine(quote,
      new Date('2026-09-01T00:00:00.000Z'), new Date('2026-10-01T00:00:00.000Z'));
    expect(line.intervals).toEqual([
      { starts_at: '2026-09-10T00:00:00.000Z', ends_at: '2026-09-15T00:00:00.000Z',
        quantity: '1' },
      { starts_at: '2026-09-15T00:00:00.000Z', ends_at: '2026-09-20T00:00:00.000Z',
        quantity: '2' },
    ]);
    expect(line.customer_charge.amount_minor).toBe('1000');
  });
});
