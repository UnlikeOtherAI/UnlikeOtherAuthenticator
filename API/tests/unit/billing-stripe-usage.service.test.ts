import {
  BillingAssignmentScope,
  BillingCollectionMode,
  BillingTariffMode,
} from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { LedgerBillingUsage } from '../../src/services/billing-ledger-collector.service.js';
import {
  exportStripeUsage,
  stripeMeterQuantityFromMajorAmount,
} from '../../src/services/billing-stripe-usage.service.js';

const capturedAt = new Date('2026-07-19T12:00:00.000Z');

function subscription() {
  return {
    id: 'subscription_1',
    customerId: 'customer_1',
    serviceId: 'service_1',
    tariffId: 'tariff_1',
    orgId: 'org_1',
    teamId: 'team_1',
    scope: BillingAssignmentScope.TEAM,
    scopeKey: 'org_1:team_1',
    stripeSubscriptionId: 'sub_1',
    stripeMonthlyItemId: 'si_monthly',
    stripeUsageItemId: 'si_usage',
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
    livemode: false,
    createdAt: capturedAt,
    updatedAt: capturedAt,
    customer: {
      id: 'customer_1',
      orgId: 'org_1',
      teamId: 'team_1',
      scope: BillingAssignmentScope.TEAM,
      scopeKey: 'org_1:team_1',
      stripeCustomerId: 'cus_1',
      createdAt: capturedAt,
      updatedAt: capturedAt,
    },
    service: {
      id: 'service_1',
      identifier: 'deepwater',
      name: 'DeepWater',
      active: true,
      createdAt: capturedAt,
      updatedAt: capturedAt,
    },
    tariff: {
      id: 'tariff_1',
      serviceId: 'service_1',
      key: 'standard',
      version: 4,
      name: 'Standard',
      mode: BillingTariffMode.STANDARD,
      collectionMode: BillingCollectionMode.STRIPE,
      markupBps: 2500,
      monthlyAmountMinor: 2999n,
      currency: 'USD',
      isDefault: false,
      createdByUserId: null,
      createdByEmail: null,
      createdAt: capturedAt,
      stripePrice: {
        id: 'price_map_1',
        tariffId: 'tariff_1',
        catalogId: 'catalog_1',
        monthlyAmountMinor: 2999n,
        stripeMonthlyPriceId: 'price_monthly_1',
        createdAt: capturedAt,
        catalog: {
          id: 'catalog_1',
          serviceId: 'service_1',
          currency: 'USD',
          meterEventName: 'uoa_rated_hash',
          stripeProductId: 'prod_1',
          stripeMeterId: 'mtr_1',
          stripeUsagePriceId: 'price_usage_1',
          createdAt: capturedAt,
          updatedAt: capturedAt,
        },
      },
    },
  };
}

function usage(
  amount = '2.5',
  cursor = 'bus_0123456789ABCDEFGHIJKLMNOPQRSTUV',
): LedgerBillingUsage {
  return {
    schemaVersion: 4,
    product: 'deepwater',
    scope: {
      organizationId: 'org_1',
      teamId: 'team_1',
      userId: null,
      month: '2026-07',
      startsAt: '2026-07-01T00:00:00.000Z',
      endsAt: '2026-08-01T00:00:00.000Z',
    },
    totals: {
      calls: 2,
      usageByService: [],
      amounts: [],
      customerCharges: [
        {
          billingProduct: 'deepwater',
          callerProduct: 'deepsignal',
          currency: 'USD',
          amount,
          calls: 2,
        },
      ],
    },
    groupBy: 'service',
    breakdown: [],
    monthlyComponents: [
      {
        billingProduct: 'deepwater',
        callerProduct: 'deepsignal',
        tariffId: 'tariff_1',
        tariffKey: 'standard',
        tariffVersion: 4,
        tariffMode: 'standard',
        markupBps: 2500,
        usageMultiplierBps: 12500,
        assignmentScope: 'team',
        assignmentId: 'assignment_1',
        amountMinor: '2999',
        currency: 'USD',
        usageBillingEnabled: true,
        collectionMode: 'stripe',
        paymentCollectionEnabled: true,
      },
    ],
    snapshot: {
      cursor,
      capturedAt: capturedAt.toISOString(),
      immutable: true,
    },
  };
}

type ExportRow = {
  id: string;
  subscriptionId: string;
  ledgerSnapshotCursor: string;
  billingMonth: string;
  billingProduct: string;
  callerProduct: string;
  currency: string;
  cumulativeCustomerCharge: string;
  cumulativeMeterQuantity: bigint;
  deltaMeterQuantity: bigint;
  stripeMeterEventIdentifier: string;
  stripeMeterEventCreatedAt: Date | null;
  createdAt: Date;
};

function setup(existing: ExportRow[] = []) {
  const rows = [...existing];
  const fullSubscription = subscription();
  const findSubscription = vi.fn(async (args: { include?: unknown }) =>
    args.include
      ? fullSubscription
      : {
          id: fullSubscription.id,
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
            row.stripeMeterEventCreatedAt === where.stripeMeterEventCreatedAt),
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
  );
  const createExport = vi.fn(async ({ data }: { data: Omit<ExportRow, 'id'> }) => {
    const row = {
      id: `export_${rows.length + 1}`,
      stripeMeterEventCreatedAt: null,
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
      where: { id: string; stripeMeterEventCreatedAt: null };
      data: { stripeMeterEventCreatedAt: Date };
    }) => {
      const row = rows.find(
        (candidate) =>
          candidate.id === where.id &&
          candidate.stripeMeterEventCreatedAt === null,
      );
      if (!row) return { count: 0 };
      row.stripeMeterEventCreatedAt = data.stripeMeterEventCreatedAt;
      return { count: 1 };
    },
  );
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: fullSubscription.id }]),
    billingStripeSubscription: { findUnique: findSubscription },
    billingStripeUsageExport: {
      findMany: findExports,
      create: createExport,
    },
  };
  const prisma = {
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
  });
  const stripe = { billing: { meterEvents: { create: meterCreate } } };
  return {
    rows,
    fullSubscription,
    prisma,
    stripe,
    meterCreate,
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
    const { prisma, stripe, meterCreate, createExport, updateExports } = setup();

    const result = await exportStripeUsage(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      {
        prisma: prisma as never,
        stripe: stripe as never,
        fetchUsage: vi.fn().mockResolvedValue(usage()),
        now: () => capturedAt,
      },
    );

    expect(createExport).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cumulativeCustomerCharge: '2.5',
        cumulativeMeterQuantity: 250_000_000n,
        deltaMeterQuantity: 250_000_000n,
        createdAt: capturedAt,
      }),
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
    expect(updateExports).toHaveBeenCalledOnce();
    expect(result.exports).toHaveLength(1);
    expect(result.exports[0]).toMatchObject({
      cumulativeMeterQuantity: '250000000',
      deltaMeterQuantity: '250000000',
    });
  });

  it('exports a negative cumulative delta when Ledger corrects a later snapshot', async () => {
    const prior = {
      id: 'export_1',
      subscriptionId: 'subscription_1',
      ledgerSnapshotCursor: 'bus_0123456789ABCDEFGHIJKLMNOPQRSTUV',
      billingMonth: '2026-07',
      billingProduct: 'deepwater',
      callerProduct: 'deepsignal',
      currency: 'USD',
      cumulativeCustomerCharge: '2.5',
      cumulativeMeterQuantity: 250_000_000n,
      deltaMeterQuantity: 250_000_000n,
      stripeMeterEventIdentifier: 'uoa_me_prior',
      stripeMeterEventCreatedAt: capturedAt,
      createdAt: capturedAt,
    };
    const later = new Date('2026-07-20T12:00:00.000Z');
    const nextUsage = usage(
      '1.25',
      'bus_1123456789ABCDEFGHIJKLMNOPQRSTUV',
    );
    nextUsage.snapshot.capturedAt = later.toISOString();
    const { prisma, stripe, meterCreate } = setup([prior]);

    await exportStripeUsage(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      {
        prisma: prisma as never,
        stripe: stripe as never,
        fetchUsage: vi.fn().mockResolvedValue(nextUsage),
        now: () => later,
      },
    );

    expect(meterCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ value: '-125000000' }),
      }),
      expect.any(Object),
    );
  });

  it('retries a durable pending export without creating a second delta row', async () => {
    const pending = {
      id: 'export_1',
      subscriptionId: 'subscription_1',
      ledgerSnapshotCursor: 'bus_0123456789ABCDEFGHIJKLMNOPQRSTUV',
      billingMonth: '2026-07',
      billingProduct: 'deepwater',
      callerProduct: 'deepsignal',
      currency: 'USD',
      cumulativeCustomerCharge: '2.5',
      cumulativeMeterQuantity: 250_000_000n,
      deltaMeterQuantity: 250_000_000n,
      stripeMeterEventIdentifier: 'uoa_me_pending',
      stripeMeterEventCreatedAt: null,
      createdAt: capturedAt,
    };
    const { prisma, stripe, meterCreate, createExport } = setup([pending]);

    await exportStripeUsage(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      {
        prisma: prisma as never,
        stripe: stripe as never,
        fetchUsage: vi.fn().mockResolvedValue(usage()),
        now: () => capturedAt,
      },
    );

    expect(createExport).not.toHaveBeenCalled();
    expect(meterCreate).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'uoa_me_pending' }),
      { idempotencyKey: 'uoa_me_pending' },
    );
  });

  it('reuses each pending row snapshot time when a later snapshot triggers delivery', async () => {
    const pending = {
      id: 'export_1',
      subscriptionId: 'subscription_1',
      ledgerSnapshotCursor: 'bus_0123456789ABCDEFGHIJKLMNOPQRSTUV',
      billingMonth: '2026-07',
      billingProduct: 'deepwater',
      callerProduct: 'deepsignal',
      currency: 'USD',
      cumulativeCustomerCharge: '2.5',
      cumulativeMeterQuantity: 250_000_000n,
      deltaMeterQuantity: 250_000_000n,
      stripeMeterEventIdentifier: 'uoa_me_pending',
      stripeMeterEventCreatedAt: null,
      createdAt: capturedAt,
    };
    const later = new Date('2026-07-20T12:00:00.000Z');
    const nextUsage = usage(
      '3.25',
      'bus_1123456789ABCDEFGHIJKLMNOPQRSTUV',
    );
    nextUsage.snapshot.capturedAt = later.toISOString();
    const { prisma, stripe, meterCreate } = setup([pending]);

    await exportStripeUsage(
      { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
      {
        prisma: prisma as never,
        stripe: stripe as never,
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

  it('rejects snapshots beyond Stripe clock tolerance before persisting', async () => {
    const futureUsage = usage();
    futureUsage.snapshot.capturedAt = new Date(
      capturedAt.getTime() + 6 * 60 * 1000,
    ).toISOString();
    const { prisma, stripe, createExport } = setup();

    await expect(
      exportStripeUsage(
        { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
        {
          prisma: prisma as never,
          stripe: stripe as never,
          fetchUsage: vi.fn().mockResolvedValue(futureUsage),
          now: () => capturedAt,
        },
      ),
    ).rejects.toThrow('STRIPE_USAGE_MONTH_OUT_OF_RANGE');
    expect(createExport).not.toHaveBeenCalled();
  });

  it('rejects usage outside the subscription exact UTC billing period', async () => {
    const { prisma, stripe, fullSubscription, createExport } = setup();
    fullSubscription.currentPeriodStart = new Date(
      '2026-07-02T00:00:00.000Z',
    );

    await expect(
      exportStripeUsage(
        { subscriptionId: 'subscription_1', billingMonth: '2026-07' },
        {
          prisma: prisma as never,
          stripe: stripe as never,
          fetchUsage: vi.fn().mockResolvedValue(usage()),
          now: () => capturedAt,
        },
      ),
    ).rejects.toThrow('LEDGER_BILLING_SCOPE_MISMATCH');
    expect(createExport).not.toHaveBeenCalled();
  });

  it('fails closed on cross-tenant, tariff, or collection mismatches', async () => {
    const scenarios = [
      (value: LedgerBillingUsage) => {
        value.scope.organizationId = 'org_other';
      },
      (value: LedgerBillingUsage) => {
        value.monthlyComponents[0]!.tariffId = 'tariff_other';
      },
      (value: LedgerBillingUsage) => {
        value.monthlyComponents[0]!.collectionMode = 'none';
      },
      (value: LedgerBillingUsage) => {
        value.totals.customerCharges[0]!.currency = 'EUR';
      },
      (value: LedgerBillingUsage) => {
        value.monthlyComponents.push({ ...value.monthlyComponents[0]! });
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
            fetchUsage: vi.fn().mockResolvedValue(value),
            now: () => capturedAt,
          },
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(meterCreate).not.toHaveBeenCalled();
    }
  });
});
