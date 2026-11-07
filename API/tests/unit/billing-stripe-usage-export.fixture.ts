import { vi } from 'vitest';
import { BillingStripeMeterEventState } from '@prisma/client';
import { capturedAt, stripeAccount, subscriptionFixture } from './billing-stripe-usage.test-fixtures.js';

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

export function setup(existing: ExportRow[] = [], confirmedOffset = 0n,
  teamStatus: 'ACTIVE' | 'DISABLED' | 'ARCHIVED' = 'ACTIVE') {
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
          tariff: { usagePaymentMode: fullSubscription.tariff.usagePaymentMode },
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
    team: { findUniqueOrThrow: vi.fn().mockResolvedValue({ orgId: 'org_1', lifecycleStatus: teamStatus }) },
    $queryRaw: vi.fn().mockImplementation(async (query: { strings?: string[] }) =>
      query.strings?.join('').includes('billing_credit_accounts')
        ? [{ id: 'credit_account_1' }]
        : [{ id: fullSubscription.id }]),
    billingStripeSubscription: { findUnique: findSubscription, findUniqueOrThrow: findSubscription },
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

