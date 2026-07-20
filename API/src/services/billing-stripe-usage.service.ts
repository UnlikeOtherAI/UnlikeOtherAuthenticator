import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import type Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  fetchLedgerBillingUsage,
  type LedgerBillingUsage,
} from './billing-ledger-collector.service.js';
import {
  assertStripeObjectLivemode,
  requireStripeBillingEnabled,
  resolveStripeAccountContext,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import {
  assertStripeUsageScope,
  assertStripeUsageSubscription,
  stripeUsageChargeKey,
  stripeUsageMeterTimestamp,
  stripeUsageMonthBounds,
  stripeUsageSubscriptionInclude,
  validatedStripeCumulativeCharges,
} from './billing-stripe-usage-validation.service.js';

type UsageExportRow = Prisma.BillingStripeUsageExportGetPayload<Record<string, never>>;
type StripeUsageClient = Pick<Stripe, 'accounts' | 'billing'>;

export { stripeMeterQuantityFromMajorAmount } from './billing-stripe-usage-validation.service.js';

export type StripeUsageExportResult = {
  ledgerSnapshotCursor: string;
  billingMonth: string;
  exports: Array<{
    id: string;
    billingProduct: string;
    callerProduct: string;
    currency: string;
    cumulativeCustomerCharge: string;
    cumulativeMeterQuantity: string;
    deltaMeterQuantity: string;
    stripeMeterEventIdentifier: string;
    stripeMeterEventCreatedAt: string | null;
  }>;
};

function eventIdentifier(params: {
  accountId: string;
  subscriptionId: string;
  cursor: string;
  callerProduct: string;
  currency: string;
}): string {
  const digest = createHash('sha256')
    .update(
      [
        params.accountId,
        params.subscriptionId,
        params.cursor,
        params.callerProduct,
        params.currency,
      ].join('\0'),
    )
    .digest('hex');
  return `uoa_me_${digest}`;
}

function serializeExport(row: UsageExportRow): StripeUsageExportResult['exports'][number] {
  return {
    id: row.id,
    billingProduct: row.billingProduct,
    callerProduct: row.callerProduct,
    currency: row.currency,
    cumulativeCustomerCharge: row.cumulativeCustomerCharge,
    cumulativeMeterQuantity: row.cumulativeMeterQuantity.toString(),
    deltaMeterQuantity: row.deltaMeterQuantity.toString(),
    stripeMeterEventIdentifier: row.stripeMeterEventIdentifier,
    stripeMeterEventCreatedAt: row.stripeMeterEventCreatedAt?.toISOString() ?? null,
  };
}

async function prepareExports(
  params: {
    subscriptionId: string;
    billingMonth: string;
    usage: LedgerBillingUsage;
    invoicePeriod?: { startsAt: Date; endsAt: Date };
  },
  prisma: PrismaClient,
): Promise<{
  pending: UsageExportRow[];
  meterEventName: string;
  stripeCustomerId: string;
}> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT "id"
        FROM "billing_stripe_subscriptions"
        WHERE "id" = ${params.subscriptionId}
        FOR UPDATE
      `,
    );
    if (locked.length !== 1) {
      throw new AppError('NOT_FOUND', 404, 'STRIPE_SUBSCRIPTION_NOT_FOUND');
    }
    const subscription = await tx.billingStripeSubscription.findUnique({
      where: { id: params.subscriptionId },
      include: stripeUsageSubscriptionInclude,
    });
    if (!subscription) {
      throw new AppError('NOT_FOUND', 404, 'STRIPE_SUBSCRIPTION_NOT_FOUND');
    }
    assertStripeUsageSubscription(subscription, {
      allowCanceledInvoicePeriod: Boolean(params.invoicePeriod),
    });
    assertStripeUsageScope(params.usage, subscription, params.billingMonth, params.invoicePeriod);
    const charges = validatedStripeCumulativeCharges(params.usage, subscription);
    const capturedAt = new Date(params.usage.snapshot.capturedAt);
    const previousRows = await tx.billingStripeUsageExport.findMany({
      where: {
        subscriptionId: subscription.id,
        billingMonth: params.billingMonth,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const alreadyPrepared = previousRows.some(
      (row) => row.ledgerSnapshotCursor === params.usage.snapshot.cursor,
    );
    if (
      !alreadyPrepared &&
      previousRows[0] &&
      previousRows[0].createdAt.getTime() > capturedAt.getTime() &&
      previousRows[0].ledgerSnapshotCursor !== params.usage.snapshot.cursor
    ) {
      throw new AppError('BAD_REQUEST', 409, 'LEDGER_BILLING_SNAPSHOT_STALE');
    }

    const latestByKey = new Map<string, UsageExportRow>();
    const existingByKey = new Map<string, UsageExportRow>();
    for (const row of previousRows) {
      const key = stripeUsageChargeKey(row.callerProduct, row.currency);
      if (!latestByKey.has(key)) latestByKey.set(key, row);
      if (row.ledgerSnapshotCursor === params.usage.snapshot.cursor) {
        existingByKey.set(key, row);
      }
    }
    for (const [key, previous] of latestByKey) {
      charges.set(
        key,
        charges.get(key) ?? {
          billingProduct: previous.billingProduct,
          callerProduct: previous.callerProduct,
          currency: previous.currency,
          amount: '0',
          quantity: 0n,
        },
      );
    }

    for (const [key, charge] of charges) {
      const existing = existingByKey.get(key);
      if (existing) {
        if (
          existing.billingProduct !== charge.billingProduct ||
          existing.cumulativeCustomerCharge !== charge.amount ||
          existing.cumulativeMeterQuantity !== charge.quantity
        ) {
          throw new AppError('INTERNAL', 502, 'LEDGER_BILLING_SNAPSHOT_MUTATED');
        }
        continue;
      }
      const previousQuantity = latestByKey.get(key)?.cumulativeMeterQuantity ?? 0n;
      const delta = charge.quantity - previousQuantity;
      if (delta === 0n) continue;
      await tx.billingStripeUsageExport.create({
        data: {
          accountId: subscription.accountId,
          subscriptionId: subscription.id,
          ledgerSnapshotCursor: params.usage.snapshot.cursor,
          billingMonth: params.billingMonth,
          billingProduct: charge.billingProduct,
          callerProduct: charge.callerProduct,
          currency: charge.currency,
          cumulativeCustomerCharge: charge.amount,
          cumulativeMeterQuantity: charge.quantity,
          deltaMeterQuantity: delta,
          stripeMeterEventIdentifier: eventIdentifier({
            accountId: subscription.accountId,
            subscriptionId: subscription.id,
            cursor: params.usage.snapshot.cursor,
            callerProduct: charge.callerProduct,
            currency: charge.currency,
          }),
          createdAt: capturedAt,
        },
      });
    }

    const pending = await tx.billingStripeUsageExport.findMany({
      where: {
        subscriptionId: subscription.id,
        billingMonth: params.billingMonth,
        stripeMeterEventCreatedAt: null,
      },
      orderBy: [{ createdAt: 'asc' }, { callerProduct: 'asc' }, { currency: 'asc' }],
    });
    const stripePrice = subscription.tariff.stripePrices.find(
      (candidate) => candidate.accountId === subscription.accountId,
    );
    const stripeCustomerId = subscription.customer.stripeCustomerId;
    if (!stripePrice || !stripeCustomerId) {
      throw new AppError('INTERNAL', 500, 'STRIPE_SUBSCRIPTION_NOT_METERABLE');
    }
    return {
      pending,
      meterEventName: stripePrice.catalog.meterEventName,
      stripeCustomerId,
    };
  });
}

async function sendPendingExports(
  params: {
    pending: UsageExportRow[];
    meterEventName: string;
    stripeCustomerId: string;
    now: Date;
    account: StripeAccountContext;
  },
  stripe: StripeUsageClient,
  prisma: PrismaClient,
): Promise<void> {
  for (const row of params.pending) {
    const timestamp = stripeUsageMeterTimestamp(row.createdAt, row.billingMonth, params.now);
    const event = await stripe.billing.meterEvents.create(
      {
        event_name: params.meterEventName,
        payload: {
          stripe_customer_id: params.stripeCustomerId,
          value: row.deltaMeterQuantity.toString(),
        },
        identifier: row.stripeMeterEventIdentifier,
        timestamp,
      },
      { idempotencyKey: row.stripeMeterEventIdentifier },
    );
    assertStripeObjectLivemode(event, params.account.livemode);
    await prisma.billingStripeUsageExport.updateMany({
      where: {
        id: row.id,
        stripeMeterEventCreatedAt: null,
      },
      data: {
        stripeMeterEventCreatedAt: new Date(event.created * 1000),
      },
    });
  }
}

export async function exportStripeUsage(
  params: {
    subscriptionId: string;
    billingMonth: string;
    cursor?: string;
  },
  deps?: {
    prisma?: PrismaClient;
    stripe?: StripeUsageClient;
    stripeLivemode?: boolean;
    fetchUsage?: typeof fetchLedgerBillingUsage;
    now?: () => Date;
    invoicePeriod?: { startsAt: Date; endsAt: Date };
  },
): Promise<StripeUsageExportResult> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const subscription = await prisma.billingStripeSubscription.findUnique({
    where: { id: params.subscriptionId },
    select: {
      id: true,
      accountId: true,
      livemode: true,
      account: {
        select: { stripeAccountId: true, livemode: true },
      },
      orgId: true,
      teamId: true,
      service: { select: { identifier: true } },
    },
  });
  if (!subscription) {
    throw new AppError('NOT_FOUND', 404, 'STRIPE_SUBSCRIPTION_NOT_FOUND');
  }
  stripeUsageMonthBounds(params.billingMonth);
  const usage = await (deps?.fetchUsage ?? fetchLedgerBillingUsage)({
    product: subscription.service.identifier,
    organisationId: subscription.orgId,
    teamId: subscription.teamId,
    billingMonth: params.billingMonth,
    cursor: params.cursor,
  });
  const now = deps?.now?.() ?? new Date();
  stripeUsageMeterTimestamp(new Date(usage.snapshot.capturedAt), params.billingMonth, now);
  const configured = deps?.stripe ? undefined : requireStripeBillingEnabled();
  const stripe = deps?.stripe ?? configured?.client;
  if (!stripe) {
    throw new AppError('INTERNAL', 503, 'STRIPE_BILLING_DISABLED');
  }
  const account = await resolveStripeAccountContext(
    stripe,
    deps?.stripeLivemode ?? configured?.livemode ?? false,
    prisma,
  );
  if (
    account.id !== subscription.accountId ||
    account.stripeAccountId !== subscription.account.stripeAccountId ||
    account.livemode !== subscription.livemode ||
    account.livemode !== subscription.account.livemode
  ) {
    throw new AppError('BAD_REQUEST', 409, 'STRIPE_ACCOUNT_MISMATCH');
  }
  const prepared = await prepareExports(
    {
      subscriptionId: subscription.id,
      billingMonth: params.billingMonth,
      usage,
      invoicePeriod: deps?.invoicePeriod,
    },
    prisma,
  );
  await sendPendingExports(
    {
      pending: prepared.pending,
      meterEventName: prepared.meterEventName,
      stripeCustomerId: prepared.stripeCustomerId,
      now,
      account,
    },
    stripe,
    prisma,
  );

  const current = await prisma.billingStripeUsageExport.findMany({
    where: {
      subscriptionId: subscription.id,
      ledgerSnapshotCursor: usage.snapshot.cursor,
    },
    orderBy: [{ callerProduct: 'asc' }, { currency: 'asc' }],
  });
  return {
    ledgerSnapshotCursor: usage.snapshot.cursor,
    billingMonth: params.billingMonth,
    exports: current.map(serializeExport),
  };
}
