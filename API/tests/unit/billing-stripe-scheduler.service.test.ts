import { BillingCollectionMode, BillingTariffMode } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  runStripeUsageExportCycle,
  startStripeUsageExportScheduler,
} from '../../src/services/billing-stripe-scheduler.service.js';

const now = new Date('2026-07-31T23:30:00.000Z');
const account = {
  id: 'stripe_account_row',
  stripeAccountId: 'acct_uoa_test',
  livemode: false,
};

function setup() {
  const subscriptions = [
    {
      id: 'subscription_final',
      currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
    },
    {
      id: 'subscription_failed',
      currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
    },
  ];
  const prisma = {
    billingStripeAccount: { upsert: vi.fn().mockResolvedValue(account) },
    billingStripeSubscription: {
      findMany: vi.fn().mockResolvedValue(subscriptions),
    },
  };
  const stripe = {
    accounts: {
      retrieveCurrent: vi.fn().mockResolvedValue({ id: account.stripeAccountId }),
    },
    billing: { meterEvents: { create: vi.fn() } },
  };
  const exportUsage = vi
    .fn()
    .mockResolvedValueOnce({
      ledgerSnapshotCursor: 'bus_final',
      billingMonth: '2026-07',
      exports: [],
    })
    .mockRejectedValueOnce(new Error('LEDGER_TEMPORARILY_UNAVAILABLE'));
  return { prisma, stripe, exportUsage };
}

describe('recurring Stripe usage export scheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('selects only current Stripe-paid subscriptions and schedules a safety pass', async () => {
    const state = setup();
    const result = await runStripeUsageExportCycle({
      prisma: state.prisma as never,
      stripe: state.stripe as never,
      stripeLivemode: false,
      exportUsage: state.exportUsage as never,
      now: () => now,
      safetyLeadMinutes: 60,
      safetyOffsetMinutes: 1,
    });

    expect(state.prisma.billingStripeSubscription.findMany).toHaveBeenCalledWith({
      where: {
        accountId: account.id,
        livemode: false,
        status: { in: ['active', 'trialing', 'past_due', 'unpaid'] },
        currentPeriodStart: { not: null, lte: now },
        currentPeriodEnd: { not: null, gt: now },
        service: { active: true },
        tariff: {
          collectionMode: BillingCollectionMode.STRIPE,
          mode: { not: BillingTariffMode.FREE },
        },
      },
      select: {
        id: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
      },
      orderBy: { id: 'asc' },
    });
    expect(state.exportUsage).toHaveBeenCalledTimes(2);
    expect(state.exportUsage).toHaveBeenNthCalledWith(
      1,
      { subscriptionId: 'subscription_final', billingMonth: '2026-07' },
      expect.objectContaining({
        prisma: state.prisma,
        stripe: state.stripe,
        stripeLivemode: false,
      }),
    );
    expect(result).toMatchObject({
      accountId: account.id,
      attempted: 2,
      succeeded: 1,
      failed: 1,
      skippedAlignmentPeriods: 0,
      preBoundarySafetyPasses: 0,
    });
    expect(result.results).toEqual([
      {
        subscriptionId: 'subscription_final',
        billingMonth: '2026-07',
        preBoundarySafetyPass: false,
        preBoundarySafetyPassAt: '2026-07-31T23:59:00.000Z',
        ledgerSnapshotCursor: 'bus_final',
      },
      {
        subscriptionId: 'subscription_failed',
        billingMonth: '2026-07',
        preBoundarySafetyPass: false,
        preBoundarySafetyPassAt: '2026-07-31T23:59:00.000Z',
        error: 'LEDGER_TEMPORARILY_UNAVAILABLE',
      },
    ]);
  });

  it('marks the exact configured pre-boundary cycle as a safety pass', async () => {
    const state = setup();
    state.prisma.billingStripeSubscription.findMany.mockResolvedValue([
      {
        id: 'subscription_final',
        currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);
    state.exportUsage.mockReset().mockResolvedValue({
      ledgerSnapshotCursor: 'bus_exact_final',
      billingMonth: '2026-07',
      exports: [],
    });

    const result = await runStripeUsageExportCycle({
      prisma: state.prisma as never,
      stripe: state.stripe as never,
      stripeLivemode: false,
      exportUsage: state.exportUsage as never,
      now: () => new Date('2026-07-31T23:59:30.000Z'),
      safetyLeadMinutes: 60,
      safetyOffsetMinutes: 1,
    });

    expect(result.preBoundarySafetyPasses).toBe(1);
    expect(result.results[0]).toMatchObject({
      billingMonth: '2026-07',
      preBoundarySafetyPass: true,
      ledgerSnapshotCursor: 'bus_exact_final',
    });
    expect(result.results[0]).not.toHaveProperty('preBoundarySafetyPassAt');
  });

  it('treats the initial alignment stub as free and never exports a full-month snapshot', async () => {
    const state = setup();
    state.prisma.billingStripeSubscription.findMany.mockResolvedValue([
      {
        id: 'subscription_alignment',
        currentPeriodStart: new Date('2026-07-20T12:00:00.000Z'),
        currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);

    const result = await runStripeUsageExportCycle({
      prisma: state.prisma as never,
      stripe: state.stripe as never,
      stripeLivemode: false,
      exportUsage: state.exportUsage as never,
      now: () => now,
      safetyLeadMinutes: 60,
      safetyOffsetMinutes: 1,
    });

    expect(state.exportUsage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skippedAlignmentPeriods: 1,
      preBoundarySafetyPasses: 0,
      results: [
        {
          subscriptionId: 'subscription_alignment',
          billingMonth: null,
          preBoundarySafetyPass: false,
          skippedReason: 'free_alignment_period',
        },
      ],
    });
  });

  it('fails visibly instead of treating an arbitrary partial period as free', async () => {
    const state = setup();
    state.prisma.billingStripeSubscription.findMany.mockResolvedValue([
      {
        id: 'subscription_drifted',
        currentPeriodStart: new Date('2026-07-20T12:00:00.000Z'),
        currentPeriodEnd: new Date('2026-08-20T12:00:00.000Z'),
      },
    ]);

    const result = await runStripeUsageExportCycle({
      prisma: state.prisma as never,
      stripe: state.stripe as never,
      stripeLivemode: false,
      exportUsage: state.exportUsage as never,
      now: () => now,
      safetyLeadMinutes: 60,
      safetyOffsetMinutes: 1,
    });

    expect(state.exportUsage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      skippedAlignmentPeriods: 0,
      results: [
        {
          subscriptionId: 'subscription_drifted',
          billingMonth: null,
          preBoundarySafetyPass: false,
          error: 'STRIPE_BILLING_PERIOD_NOT_CALENDAR_ALIGNED',
        },
      ],
    });
  });

  it('runs the computed pre-boundary safety timer even between recurring ticks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T23:58:59.000Z'));
    const scheduledResult = {
      accountId: account.id,
      attempted: 1,
      succeeded: 1,
      failed: 0,
      skippedAlignmentPeriods: 0,
      preBoundarySafetyPasses: 0,
      results: [
        {
          subscriptionId: 'subscription_final',
          billingMonth: '2026-07',
          preBoundarySafetyPass: false,
          preBoundarySafetyPassAt: '2026-07-31T23:59:00.000Z',
          ledgerSnapshotCursor: 'bus_before_final',
        },
      ],
    };
    const safetyResult = {
      ...scheduledResult,
      preBoundarySafetyPasses: 1,
      results: [
        {
          subscriptionId: 'subscription_final',
          billingMonth: '2026-07',
          preBoundarySafetyPass: true,
          ledgerSnapshotCursor: 'bus_exact_final',
        },
      ],
    };
    const runCycle = vi.fn().mockResolvedValueOnce(scheduledResult).mockResolvedValue(safetyResult);
    const scheduler = startStripeUsageExportScheduler({
      log: { info: vi.fn(), error: vi.fn() },
      runCycle,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(runCycle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runCycle).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('preserves the logger receiver when a usage export cycle reports failures', async () => {
    vi.useFakeTimers();
    const receivers: unknown[] = [];
    const log = {
      info: vi.fn(function (this: unknown) {
        receivers.push(this);
      }),
      error: vi.fn(function (this: unknown) {
        receivers.push(this);
      }),
    };
    const scheduler = startStripeUsageExportScheduler({
      log,
      runCycle: vi.fn().mockResolvedValue({
        accountId: account.id,
        attempted: 1,
        succeeded: 0,
        failed: 1,
        skippedAlignmentPeriods: 0,
        preBoundarySafetyPasses: 0,
        results: [
          {
            subscriptionId: 'subscription_failed',
            billingMonth: '2026-07',
            preBoundarySafetyPass: false,
            error: 'LEDGER_TEMPORARILY_UNAVAILABLE',
          },
        ],
      }),
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(log.error).toHaveBeenCalledOnce();
    expect(log.info).not.toHaveBeenCalled();
    expect(receivers).toEqual([log]);
    scheduler.stop();
  });
});
