import { describe, expect, it, vi } from 'vitest';

import { quoteUnexportedClosedPeriodLiability } from '../../src/services/billing-stripe-invoice-close-quote.service.js';
import { subscriptionFixture, usageFixture } from './billing-stripe-usage.test-fixtures.js';

describe('finalized Stripe period liability', () => {
  it('records exact UOA-rated unexported liability after the invoice is closed', async () => {
    const subscription = subscriptionFixture();
    const usage = usageFixture('1.04'); // 25% fixture tariff produces $1.30.
    const prisma = {
      billingStripeSubscription: { findUniqueOrThrow: vi.fn().mockResolvedValue(subscription) },
      billingStripeUsageExport: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const result = await quoteUnexportedClosedPeriodLiability({
      subscriptionId: subscription.id,
      billingMonth: '2026-07',
    }, {
      prisma: prisma as never,
      fetchUsage: vi.fn().mockResolvedValue(usage),
      settleCredits: vi.fn().mockResolvedValue(0n),
    });
    expect(result).toEqual({
      ledgerSnapshotCursor: usage.snapshot.cursor,
      amountMicroMinor: 130_000_000n,
      currency: 'USD',
    });
  });

  it('deducts previously exported net quantity and current prepaid credits once', async () => {
    const subscription = subscriptionFixture();
    const usage = usageFixture('2.08'); // $2.60 gross.
    const prisma = {
      billingStripeSubscription: { findUniqueOrThrow: vi.fn().mockResolvedValue(subscription) },
      billingStripeUsageExport: { findMany: vi.fn().mockResolvedValue([{
        callerProduct: 'deepsignal', currency: 'USD', billingProduct: 'deepwater',
        cumulativeGrossMeterQuantity: 130_000_000n,
        cumulativeMeterQuantity: 130_000_000n,
      }]) },
    };
    const result = await quoteUnexportedClosedPeriodLiability({
      subscriptionId: subscription.id,
      billingMonth: '2026-07',
    }, {
      prisma: prisma as never,
      fetchUsage: vi.fn().mockResolvedValue(usage),
      settleCredits: vi.fn().mockResolvedValue(50_000_000n),
    });
    expect(result.amountMicroMinor).toBe(80_000_000n); // $0.80 remains beyond $1.30 exported and $0.50 prepaid.
  });

  it('holds an accepted meter event that missed the finalized invoice lines', async () => {
    const subscription = subscriptionFixture();
    const usage = usageFixture('1.04');
    const prisma = {
      billingStripeSubscription: { findUniqueOrThrow: vi.fn().mockResolvedValue(subscription) },
      billingStripeUsageExport: { findMany: vi.fn().mockResolvedValue([{
        callerProduct: 'deepsignal', currency: 'USD', billingProduct: 'deepwater',
        cumulativeGrossMeterQuantity: 130_000_000n,
        cumulativeMeterQuantity: 130_000_000n,
      }]) },
    };
    const result = await quoteUnexportedClosedPeriodLiability({
      subscriptionId: subscription.id,
      billingMonth: '2026-07',
      invoicedUsageAmountMinor: 0n,
    }, {
      prisma: prisma as never,
      fetchUsage: vi.fn().mockResolvedValue(usage),
      settleCredits: vi.fn().mockResolvedValue(0n),
    });
    expect(result.amountMicroMinor).toBe(130_000_000n);
  });

  it('quotes only new late usage after an earlier paid adjustment', async () => {
    const subscription = subscriptionFixture();
    const usage = usageFixture('2.08');
    const prisma = {
      billingStripeSubscription: { findUniqueOrThrow: vi.fn().mockResolvedValue(subscription) },
      billingStripeUsageExport: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const result = await quoteUnexportedClosedPeriodLiability({
      subscriptionId: subscription.id,
      billingMonth: '2026-07',
      invoicedUsageAmountMinor: 0n,
      paidAdjustmentsAmountMinor: 130n,
    }, {
      prisma: prisma as never,
      fetchUsage: vi.fn().mockResolvedValue(usage),
      settleCredits: vi.fn().mockResolvedValue(0n),
    });
    expect(result.amountMicroMinor).toBe(130_000_000n);
  });
});
