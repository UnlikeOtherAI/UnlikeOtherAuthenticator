import { describe, expect, it, vi } from 'vitest';
import { BillingStripeMeterEventState } from '@prisma/client';
import { exportStripeUsage, stripeMeterQuantityFromMajorAmount } from '../../src/services/billing-stripe-usage.service.js';
import { capturedAt, stripeAccount, usageFixture as usage } from './billing-stripe-usage.test-fixtures.js';
import { setup } from './billing-stripe-usage-export.fixture.js';

describe('Stripe usage rating', () => {
  it.each(['ACTIVE', 'DISABLED', 'ARCHIVED'] as const)('settles earned usage unless the team is archived (%s)', async status => {
    const { prisma, stripe, meterCreate } = setup([], 0n, status);
    const result = exportStripeUsage({ subscriptionId: 'subscription_1', billingMonth: '2026-07' }, {
      prisma: prisma as never, stripe: stripe as never, settleCredits: vi.fn().mockResolvedValue(0n),
      fetchUsage: vi.fn().mockResolvedValue(usage()), now: () => capturedAt,
    });
    if (status === 'ARCHIVED') {
      await expect(result).rejects.toThrow('ARCHIVE_BILLING_COLLECTION_HELD');
      expect(meterCreate).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toMatchObject({ billingMonth: '2026-07' });
      expect(meterCreate).toHaveBeenCalledOnce();
    }
  });
  it('converts major currency exactly to integer micro-minor units', () => {
    expect(stripeMeterQuantityFromMajorAmount('2.5', 'USD')).toBe(250_000_000n);
    expect(stripeMeterQuantityFromMajorAmount('2.5', 'JPY')).toBe(2_500_000n);
    expect(stripeMeterQuantityFromMajorAmount('0.000000005', 'USD')).toBe(1n);
    expect(stripeMeterQuantityFromMajorAmount('0.000000004', 'USD')).toBe(0n);
  });

  it('persists a cumulative delta under lock and emits one stable Stripe event', async () => {
    const { prisma, stripe, meterCreate, payerVersionBump, createExport, updateExports } = setup();

    const result = await exportStripeUsage(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      {
        prisma: prisma as never,
        stripe: stripe as never,
        settleCredits: vi.fn().mockResolvedValue(0n),
        fetchUsage: vi.fn().mockResolvedValue(usage()),
        now: () => capturedAt,
      },
    );

    expect(createExport).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cumulativeCustomerCharge: '2.5',
        cumulativeMeterQuantity: 250_000_000n,
      cumulativeGrossMeterQuantity: 250_000_000n,
        deltaMeterQuantity: 250_000_000n,
        createdAt: capturedAt,
      }),
    });
    expect(payerVersionBump).toHaveBeenCalledWith({
      where: { id: { in: ['credit_account_1'] } },
      data: { updatedAt: expect.any(Date) },
    });
    expect(meterCreate).toHaveBeenCalledWith(
      {
        event_name: 'uoa_rated_hash',
        payload: {
          stripe_customer_id: 'cus_1',
          value: '250000000',
        },
        identifier: expect.stringMatching(/^uoa_me_[a-f0-9]{64}$/),
        timestamp: Math.floor(capturedAt.getTime() / 1000),
      },
      { idempotencyKey: expect.stringMatching(/^uoa_me_[a-f0-9]{64}$/) },
    );
    expect(updateExports).toHaveBeenCalledTimes(2);
    expect(result.exports).toHaveLength(1);
    expect(result.exports[0]).toMatchObject({
      cumulativeMeterQuantity: '250000000',
      deltaMeterQuantity: '250000000',
    });
  });

  it('rates Ledger selected cost without dropping estimate-only rows from a mixed aggregate', async () => {
    const mixedUsage = usage();
    const line = mixedUsage.lines[0];
    if (!line) throw new Error('usage fixture requires one line');
    line.estimatedProviderCost = '3.5';
    line.actualProviderCost = '1';
    line.selectedProviderCost = '3';
    const { prisma, stripe, createExport } = setup();

    await exportStripeUsage(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      {
        prisma: prisma as never,
        stripe: stripe as never,
        settleCredits: vi.fn().mockResolvedValue(0n),
        fetchUsage: vi.fn().mockResolvedValue(mixedUsage),
        now: () => capturedAt,
      },
    );

    expect(createExport).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cumulativeCustomerCharge: '3.75',
        cumulativeMeterQuantity: 375_000_000n,
      }),
    });
  });

  it('subtracts prepaid credits once from cumulative metered usage', async () => {
    const { prisma, stripe, createExport, meterCreate } = setup([], 50_000_000n);
    await exportStripeUsage(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      {
        prisma: prisma as never,
        stripe: stripe as never,
        settleCredits: vi.fn().mockResolvedValue(50_000_000n),
        fetchUsage: vi.fn().mockResolvedValue(usage()),
        now: () => capturedAt,
      },
    );
    expect(createExport).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cumulativeCustomerCharge: '2',
        cumulativeMeterQuantity: 200_000_000n,
      }),
    });
    expect(meterCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ value: '200000000' }) }),
      expect.any(Object),
    );
  });

  it('keeps caller A charged while applying later credits only to caller B new usage', async () => {
    const prior = {
      id: 'export_caller_a', accountId: stripeAccount.id, subscriptionId: 'subscription_1',
      ledgerSnapshotCursor: 'mus_0123456789ABCDEFGHIJKLMNOPQRSTUV',
      billingMonth: '2026-07', billingProduct: 'deepwater', callerProduct: 'deepsignal',
      currency: 'USD', cumulativeCustomerCharge: '1.25',
      cumulativeMeterQuantity: 125_000_000n, cumulativeGrossMeterQuantity: 125_000_000n,
      deltaMeterQuantity: 125_000_000n, stripeMeterEventIdentifier: 'uoa_me_caller_a',
      stripeMeterEventCreatedAt: capturedAt, stripeMeterEventState: BillingStripeMeterEventState.ACCEPTED,
      createdAt: capturedAt,
    };
    const next = usage('1', 'mus_1123456789ABCDEFGHIJKLMNOPQRSTUV');
    next.snapshot.capturedAt = new Date(capturedAt.getTime() + 60_000).toISOString();
    next.lines.push({ ...next.lines[0]!, callerProduct: 'deeptest' });
    const { prisma, stripe, createExport, meterCreate } = setup([prior], 50_000_000n);
    await exportStripeUsage(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      {
        prisma: prisma as never, stripe: stripe as never,
        settleCredits: vi.fn().mockResolvedValue(50_000_000n),
        fetchUsage: vi.fn().mockResolvedValue(next),
        now: () => new Date(capturedAt.getTime() + 60_000),
      },
    );
    expect(createExport).toHaveBeenCalledTimes(1);
    expect(createExport).toHaveBeenCalledWith({ data: expect.objectContaining({
      callerProduct: 'deeptest', cumulativeGrossMeterQuantity: 125_000_000n,
      cumulativeMeterQuantity: 75_000_000n, deltaMeterQuantity: 75_000_000n,
    }) });
    expect(meterCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ value: '75000000' }) }),
      expect.any(Object),
    );
  });

  it('holds if a later allocation would reduce already exported Stripe usage', async () => {
    const prior = {
      id: 'export_gross_first',
      accountId: stripeAccount.id,
      subscriptionId: 'subscription_1',
      ledgerSnapshotCursor: 'mus_0123456789ABCDEFGHIJKLMNOPQRSTUV',
      billingMonth: '2026-07',
      billingProduct: 'deepwater',
      callerProduct: 'deepsignal',
      currency: 'USD',
      cumulativeCustomerCharge: '2.5',
      cumulativeMeterQuantity: 250_000_000n,
      cumulativeGrossMeterQuantity: 250_000_000n,
      deltaMeterQuantity: 250_000_000n,
      stripeMeterEventIdentifier: 'uoa_me_gross_first',
      stripeMeterEventCreatedAt: capturedAt,
      stripeMeterEventAttemptedAt: capturedAt,
      stripeMeterEventState: BillingStripeMeterEventState.ACCEPTED,
      createdAt: capturedAt,
    };
    const later = new Date(capturedAt.getTime() + 5 * 60_000);
    const next = usage('2', 'mus_1123456789ABCDEFGHIJKLMNOPQRSTUV');
    next.snapshot.capturedAt = later.toISOString();
    const { prisma, stripe, meterCreate } = setup([prior], 50_000_000n);
    await expect(exportStripeUsage(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      {
        prisma: prisma as never,
        stripe: stripe as never,
        settleCredits: vi.fn().mockResolvedValue(50_000_000n),
        fetchUsage: vi.fn().mockResolvedValue(next),
        now: () => later,
      },
    )).rejects.toThrow('STRIPE_BUCKET_CREDIT_RECONCILIATION_REQUIRED');
    expect(meterCreate).not.toHaveBeenCalled();
  });

});
