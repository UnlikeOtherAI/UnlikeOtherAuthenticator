import { describe, expect, it, vi } from 'vitest';
import { BillingStripeMeterEventState } from '@prisma/client';

import type { NormalizedMeteringUsage } from '../../src/services/billing-metering.types.js';
import {
  exportStripeUsage,
  stripeMeterQuantityFromMajorAmount,
} from '../../src/services/billing-stripe-usage.service.js';
import {
  capturedAt,
  stripeAccount,
  subscriptionFixture,
  usageFixture as usage,
} from './billing-stripe-usage.test-fixtures.js';

type ExportRow = {
  id: string;
  accountId: string;
  subscriptionId: string;
  ledgerSnapshotCursor: string;
  billingMonth: string;
  billingProduct: string;
  callerProduct: string;
  currency: string;
  cumulativeCustomerCharge: string;
  cumulativeMeterQuantity: bigint;
  cumulativeGrossMeterQuantity?: bigint | null;
  deltaMeterQuantity: bigint;
  stripeMeterEventIdentifier: string;
  stripeMeterEventCreatedAt: Date | null;
  stripeMeterEventFirstAttemptedAt?: Date | null;
  stripeMeterEventAttemptedAt?: Date | null;
  stripeMeterEventAttemptGeneration?: number;
  stripeMeterEventState?: BillingStripeMeterEventState;
  createdAt: Date;
};

function setup(existing: ExportRow[] = [], confirmedOffset = 0n) {
  const rows = [...existing];
  const fullSubscription = subscriptionFixture();
  const findSubscription = vi.fn(async (args: { include?: unknown }) =>
    args.include
      ? fullSubscription
      : {
          id: fullSubscription.id,
          accountId: fullSubscription.accountId,
          livemode: fullSubscription.livemode,
          account: {
            stripeAccountId: fullSubscription.account.stripeAccountId,
            livemode: fullSubscription.account.livemode,
          },
          orgId: fullSubscription.orgId,
          teamId: fullSubscription.teamId,
          service: { identifier: fullSubscription.service.identifier },
        },
  );
  const findExports = vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
    rows
      .filter(
        (row) =>
          row.subscriptionId === where.subscriptionId &&
          (!where.billingMonth || row.billingMonth === where.billingMonth) &&
          (!where.ledgerSnapshotCursor ||
            row.ledgerSnapshotCursor === where.ledgerSnapshotCursor) &&
          (!('stripeMeterEventCreatedAt' in where) ||
            row.stripeMeterEventCreatedAt === where.stripeMeterEventCreatedAt) &&
          (!('stripeMeterEventState' in where) ||
            typeof where.stripeMeterEventState !== 'object' ||
            row.stripeMeterEventState !== (where.stripeMeterEventState as { not: string }).not),
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
  );
  const createExport = vi.fn(async ({ data }: { data: Omit<ExportRow, 'id'> }) => {
    const row = {
      id: `export_${rows.length + 1}`,
      stripeMeterEventCreatedAt: null,
      stripeMeterEventAttemptedAt: null,
      stripeMeterEventFirstAttemptedAt: null,
      stripeMeterEventAttemptGeneration: 0,
      stripeMeterEventState: BillingStripeMeterEventState.PENDING,
      ...data,
    };
    rows.push(row);
    return row;
  });
  const updateExports = vi.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string; stripeMeterEventCreatedAt: null; stripeMeterEventState?: BillingStripeMeterEventState;
        stripeMeterEventAttemptedAt?: Date | null; stripeMeterEventFirstAttemptedAt?: Date | null;
        stripeMeterEventIdentifier?: string; stripeMeterEventAttemptGeneration?: number };
      data: {
        stripeMeterEventCreatedAt?: Date;
        stripeMeterEventAttemptedAt?: Date;
        stripeMeterEventFirstAttemptedAt?: Date;
        stripeMeterEventState?: BillingStripeMeterEventState;
      };
    }) => {
      const row = rows.find(
        (candidate) => candidate.id === where.id && candidate.stripeMeterEventCreatedAt === null &&
          (!('stripeMeterEventState' in where) || candidate.stripeMeterEventState === where.stripeMeterEventState) &&
          (!('stripeMeterEventAttemptedAt' in where) || candidate.stripeMeterEventAttemptedAt === where.stripeMeterEventAttemptedAt) &&
          (!('stripeMeterEventFirstAttemptedAt' in where) ||
            candidate.stripeMeterEventFirstAttemptedAt === where.stripeMeterEventFirstAttemptedAt) &&
          (!('stripeMeterEventIdentifier' in where) ||
            candidate.stripeMeterEventIdentifier === where.stripeMeterEventIdentifier) &&
          (!('stripeMeterEventAttemptGeneration' in where) ||
            candidate.stripeMeterEventAttemptGeneration === where.stripeMeterEventAttemptGeneration),
      );
      if (!row) return { count: 0 };
      if (data.stripeMeterEventCreatedAt) row.stripeMeterEventCreatedAt = data.stripeMeterEventCreatedAt;
      if (data.stripeMeterEventAttemptedAt) row.stripeMeterEventAttemptedAt = data.stripeMeterEventAttemptedAt;
      if (data.stripeMeterEventFirstAttemptedAt) {
        row.stripeMeterEventFirstAttemptedAt = data.stripeMeterEventFirstAttemptedAt;
      }
      if (data.stripeMeterEventState) row.stripeMeterEventState = data.stripeMeterEventState;
      return { count: 1 };
    },
  );
  const payerVersionBump = vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    $queryRaw: vi.fn().mockImplementation(async (query: { strings?: string[] }) =>
      query.strings?.join('').includes('billing_credit_accounts')
        ? [{ id: 'credit_account_1' }]
        : [{ id: fullSubscription.id }]),
    billingStripeSubscription: { findUnique: findSubscription },
    billingCreditAccount: { updateMany: payerVersionBump },
    billingCreditUsageSettlement: { findMany: vi.fn().mockResolvedValue(
      confirmedOffset ? [{ cumulativeCreditsConsumedMicrocredits: confirmedOffset * 10n }] : [],
    ) },
    billingStripeUsageExport: {
      findMany: findExports,
      create: createExport,
    },
  };
  const prisma = {
    billingStripeAccount: { upsert: vi.fn().mockResolvedValue(stripeAccount) },
    billingStripeSubscription: {
      findUnique: findSubscription,
    },
    billingStripeUsageExport: {
      findMany: findExports,
      updateMany: updateExports,
    },
    $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
  };
  const meterCreate = vi.fn().mockResolvedValue({
    created: Math.floor(capturedAt.getTime() / 1000),
    livemode: false,
  });
  const stripe = {
    accounts: {
      retrieveCurrent: vi.fn().mockResolvedValue({ id: stripeAccount.stripeAccountId }),
    },
    billing: { meterEvents: { create: meterCreate } },
  };
  return {
    rows,
    fullSubscription,
    prisma,
    stripe,
    meterCreate,
    payerVersionBump,
    createExport,
    updateExports,
  };
}

describe('Stripe usage export', () => {
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
