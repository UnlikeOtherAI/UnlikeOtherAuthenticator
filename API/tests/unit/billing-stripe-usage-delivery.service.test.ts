import { describe, expect, it, vi } from 'vitest';
import { BillingStripeMeterEventState } from '@prisma/client';
import { exportStripeUsage } from '../../src/services/billing-stripe-usage.service.js';
import { capturedAt, stripeAccount, usageFixture as usage } from './billing-stripe-usage.test-fixtures.js';
import { setup } from './billing-stripe-usage-export.fixture.js';
import type { NormalizedMeteringUsage } from '../../src/services/billing-metering.types.js';

describe('Stripe usage delivery and recovery', () => {
  it('holds an uncertain accepted event after the identifier safety window', async () => {
    const pending = {
      id: 'export_uncertain',
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
      stripeMeterEventIdentifier: 'uoa_me_uncertain',
      stripeMeterEventCreatedAt: null,
      stripeMeterEventFirstAttemptedAt: capturedAt,
      stripeMeterEventAttemptedAt: capturedAt,
      stripeMeterEventState: BillingStripeMeterEventState.UNCERTAIN,
      createdAt: capturedAt,
    };
    const { prisma, stripe, meterCreate } = setup([pending]);
    await expect(exportStripeUsage(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      {
        prisma: prisma as never,
        stripe: stripe as never,
        settleCredits: vi.fn().mockResolvedValue(0n),
        fetchUsage: vi.fn().mockResolvedValue(usage()),
        now: () => new Date(capturedAt.getTime() + 24 * 60 * 60_000),
      },
    )).rejects.toThrow('STRIPE_METER_EVENT_RECONCILIATION_REQUIRED');
    expect(meterCreate).not.toHaveBeenCalled();
  });

  it('anchors retry expiry to the first possible acceptance across repeated crashes', async () => {
    const { prisma, stripe, meterCreate, rows } = setup();
    meterCreate.mockRejectedValue(new Error('lost Stripe acknowledgement'));
    let clock = new Date(capturedAt);
    const run = () => exportStripeUsage(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      {
        prisma: prisma as never, stripe: stripe as never,
        settleCredits: vi.fn().mockResolvedValue(0n),
        fetchUsage: vi.fn().mockResolvedValue(usage()),
        now: () => clock,
      },
    );
    await expect(run()).rejects.toThrow('lost Stripe acknowledgement');
    expect(rows[0]?.stripeMeterEventFirstAttemptedAt).toEqual(capturedAt);
    clock = new Date(capturedAt.getTime() + 3 * 60_000);
    await expect(run()).rejects.toThrow('lost Stripe acknowledgement');
    expect(rows[0]?.stripeMeterEventAttemptedAt).toEqual(clock);
    expect(rows[0]?.stripeMeterEventFirstAttemptedAt).toEqual(capturedAt);
    clock = new Date(capturedAt.getTime() + 24 * 60 * 60_000);
    await expect(run()).rejects.toThrow('STRIPE_METER_EVENT_RECONCILIATION_REQUIRED');
    expect(meterCreate).toHaveBeenCalledTimes(2);
    expect(rows[0]?.stripeMeterEventState).toBe(BillingStripeMeterEventState.RECONCILIATION_REQUIRED);
  });

  it('cannot settle a new identifier generation with an old in-flight response', async () => {
    const { prisma, stripe, meterCreate, rows } = setup();
    let release!: (value: { created: number; livemode: boolean }) => void;
    const pendingResponse = new Promise<{ created: number; livemode: boolean }>((resolve) => {
      release = resolve;
    });
    meterCreate.mockImplementation(() => pendingResponse);
    const inFlight = exportStripeUsage(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      {
        prisma: prisma as never, stripe: stripe as never,
        settleCredits: vi.fn().mockResolvedValue(0n),
        fetchUsage: vi.fn().mockResolvedValue(usage()),
        now: () => capturedAt,
      },
    );
    await vi.waitFor(() => expect(meterCreate).toHaveBeenCalledTimes(1));
    const row = rows[0];
    if (!row) throw new Error('export fixture missing');
    const oldIdentifier = row.stripeMeterEventIdentifier;
    row.stripeMeterEventIdentifier = `${oldIdentifier}_r1`;
    row.stripeMeterEventAttemptGeneration = 1;
    row.stripeMeterEventState = BillingStripeMeterEventState.PENDING;
    row.stripeMeterEventAttemptedAt = null;
    row.stripeMeterEventFirstAttemptedAt = null;
    release({ created: Math.floor(capturedAt.getTime() / 1000), livemode: false });
    await expect(inFlight).rejects.toThrow('STRIPE_METER_EVENT_ACCEPTANCE_UNCERTAIN');
    expect(row.stripeMeterEventIdentifier).toBe(`${oldIdentifier}_r1`);
    expect(row.stripeMeterEventState).toBe(BillingStripeMeterEventState.PENDING);
    expect(row.stripeMeterEventCreatedAt).toBeNull();
  });

  it('holds a lower corrected snapshot for an auditable Stripe correction', async () => {
    const prior = {
      id: 'export_1',
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
      stripeMeterEventIdentifier: 'uoa_me_prior',
      stripeMeterEventCreatedAt: capturedAt,
      createdAt: capturedAt,
    };
    const later = new Date('2026-07-20T12:00:00.000Z');
    const nextUsage = usage('1', 'mus_1123456789ABCDEFGHIJKLMNOPQRSTUV');
    nextUsage.snapshot.capturedAt = later.toISOString();
    const { prisma, stripe, meterCreate } = setup([prior]);

    await expect(exportStripeUsage(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      {
        prisma: prisma as never,
        stripe: stripe as never,
        settleCredits: vi.fn().mockResolvedValue(0n),
        fetchUsage: vi.fn().mockResolvedValue(nextUsage),
        now: () => later,
      },
    )).rejects.toThrow('STRIPE_BUCKET_USAGE_RECONCILIATION_REQUIRED');
    expect(meterCreate).not.toHaveBeenCalled();
  });

  it('retries a durable pending export without creating a second delta row', async () => {
    const pending = {
      id: 'export_1',
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
      stripeMeterEventIdentifier: 'uoa_me_pending',
      stripeMeterEventCreatedAt: null,
      createdAt: capturedAt,
    };
    const { prisma, stripe, meterCreate, payerVersionBump, createExport } = setup([pending]);

    await exportStripeUsage(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      {
        prisma: prisma as never,
        stripe: stripe as never,
        settleCredits: vi.fn().mockResolvedValue(0n),
        fetchUsage: vi.fn().mockResolvedValue(usage()),
        now: () => capturedAt,
      },
    );

    expect(createExport).not.toHaveBeenCalled();
    expect(payerVersionBump).not.toHaveBeenCalled();
    expect(meterCreate).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'uoa_me_pending' }),
      { idempotencyKey: 'uoa_me_pending' },
    );
  });

  it('reuses each pending row snapshot time when a later snapshot triggers delivery', async () => {
    const pending = {
      id: 'export_1',
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
      stripeMeterEventIdentifier: 'uoa_me_pending',
      stripeMeterEventCreatedAt: null,
      createdAt: capturedAt,
    };
    const later = new Date('2026-07-20T12:00:00.000Z');
    const nextUsage = usage('2.6', 'mus_1123456789ABCDEFGHIJKLMNOPQRSTUV');
    nextUsage.snapshot.capturedAt = later.toISOString();
    const { prisma, stripe, meterCreate } = setup([pending]);

    await exportStripeUsage(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      {
        prisma: prisma as never,
        stripe: stripe as never,
        settleCredits: vi.fn().mockResolvedValue(0n),
        fetchUsage: vi.fn().mockResolvedValue(nextUsage),
        now: () => later,
      },
    );

    expect(meterCreate).toHaveBeenCalledTimes(2);
    expect(meterCreate.mock.calls[0]?.[0]).toMatchObject({
      identifier: 'uoa_me_pending',
      timestamp: Math.floor(capturedAt.getTime() / 1000),
    });
    expect(meterCreate.mock.calls[1]?.[0]).toMatchObject({
      timestamp: Math.floor(later.getTime() / 1000),
    });
  });

  it('exports usage captured after the pre-boundary safety pass into the draft renewal invoice', async () => {
    const preBoundaryCapturedAt = new Date('2026-07-31T23:59:00.000Z');
    const preBoundary = {
      id: 'export_pre_boundary',
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
      stripeMeterEventIdentifier: 'uoa_me_pre_boundary',
      stripeMeterEventCreatedAt: preBoundaryCapturedAt,
      createdAt: preBoundaryCapturedAt,
    };
    const afterBoundary = new Date('2026-08-01T00:00:10.000Z');
    const finalUsage = usage('2.2', 'mus_2123456789ABCDEFGHIJKLMNOPQRSTUV');
    finalUsage.snapshot.capturedAt = afterBoundary.toISOString();
    const { prisma, stripe, fullSubscription, meterCreate, createExport } = setup([preBoundary]);
    fullSubscription.currentPeriodStart = new Date('2026-08-01T00:00:00.000Z');
    fullSubscription.currentPeriodEnd = new Date('2026-09-01T00:00:00.000Z');

    await exportStripeUsage(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      {
        prisma: prisma as never,
        stripe: stripe as never,
        settleCredits: vi.fn().mockResolvedValue(0n),
        fetchUsage: vi.fn().mockResolvedValue(finalUsage),
        invoicePeriod: {
          startsAt: new Date('2026-07-01T00:00:00.000Z'),
          endsAt: new Date('2026-08-01T00:00:00.000Z'),
        },
        now: () => afterBoundary,
      },
    );

    expect(createExport).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cumulativeMeterQuantity: 275_000_000n,
        deltaMeterQuantity: 25_000_000n,
        createdAt: afterBoundary,
      }),
    });
    expect(meterCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ value: '25000000' }),
        timestamp: 1_785_542_399,
      }),
      expect.any(Object),
    );
  });

  it('rejects snapshots beyond Stripe clock tolerance before persisting', async () => {
    const futureUsage = usage();
    futureUsage.snapshot.capturedAt = new Date(capturedAt.getTime() + 6 * 60 * 1000).toISOString();
    const { prisma, stripe, createExport } = setup();

    await expect(
      exportStripeUsage(
        { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
        {
          prisma: prisma as never,
          stripe: stripe as never,
          settleCredits: vi.fn().mockResolvedValue(0n),
        fetchUsage: vi.fn().mockResolvedValue(futureUsage),
          now: () => capturedAt,
        },
      ),
    ).rejects.toThrow('STRIPE_USAGE_MONTH_OUT_OF_RANGE');
    expect(createExport).not.toHaveBeenCalled();
  });

  it('rejects usage outside the subscription exact UTC billing period', async () => {
    const { prisma, stripe, fullSubscription, createExport } = setup();
    fullSubscription.currentPeriodStart = new Date('2026-07-02T00:00:00.000Z');

    await expect(
      exportStripeUsage(
        { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
        {
          prisma: prisma as never,
          stripe: stripe as never,
          settleCredits: vi.fn().mockResolvedValue(0n),
        fetchUsage: vi.fn().mockResolvedValue(usage()),
          now: () => capturedAt,
        },
      ),
    ).rejects.toThrow('LEDGER_METERING_SCOPE_MISMATCH');
    expect(createExport).not.toHaveBeenCalled();
  });

  it('fails closed on cross-tenant, tariff, or collection mismatches', async () => {
    const scenarios = [
      (value: NormalizedMeteringUsage) => {
        value.scope.organizationId = 'org_other';
      },
      (value: NormalizedMeteringUsage) => {
        value.product = 'deeptest';
      },
      (value: NormalizedMeteringUsage) => {
        value.lines[0]!.billingProduct = 'deeptest';
      },
      (value: NormalizedMeteringUsage) => {
        value.lines[0]!.currency = 'EUR';
      },
      (value: NormalizedMeteringUsage) => {
        value.lines[0]!.selectedProviderCost = null;
      },
    ];

    for (const mutate of scenarios) {
      const value = usage();
      mutate(value);
      const { prisma, stripe, meterCreate } = setup();
      await expect(
        exportStripeUsage(
          { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
          {
            prisma: prisma as never,
            stripe: stripe as never,
            settleCredits: vi.fn().mockResolvedValue(0n),
        fetchUsage: vi.fn().mockResolvedValue(value),
            now: () => capturedAt,
          },
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(meterCreate).not.toHaveBeenCalled();
    }
  });
});
