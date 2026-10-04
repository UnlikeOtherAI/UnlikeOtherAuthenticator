import { BillingStripeMeterEventState, BillingUsagePaymentMode, Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import type Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { fetchLedgerMeteringUsage } from './billing-ledger-collector.service.js';
import { settleSubscriptionCreditLiability } from './billing-credit-liability.service.js';
import { assertPrepaidUsageCovered } from './billing-prepaid-coverage.service.js';
import type { NormalizedMeteringUsage } from './billing-metering.types.js';
import {
  assertStripeObjectLivemode,
  requireStripeBillingEnabled,
  resolveStripeAccountContext,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import {
  assertStripeUsageScope,
  assertStripeUsageSubscription,
  applyCreditOffsetToStripeCharges,
  stripeUsageChargeKey,
  stripeUsageMeterTimestamp,
  stripeUsageMonthBounds,
  stripeUsageSubscriptionInclude,
  validatedStripeCumulativeCharges,
} from './billing-stripe-usage-validation.service.js';

type UsageExportRow = Prisma.BillingStripeUsageExportGetPayload<Record<string, never>>;
type StripeUsageClient = Pick<Stripe, 'accounts' | 'billing'>;
const METER_EVENT_RETRY_DELAY_MS = 2 * 60_000;
const METER_EVENT_SAFE_RETRY_MS = 23 * 60 * 60_000;

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
    usage: NormalizedMeteringUsage;
    creditOffsetMicroMinor: bigint;
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
    // Share the same payer row lock used by credit settlement. The offset was
    // refreshed before this transaction; rechecking under the lock makes the
    // meter reservation and prepaid allocation one serializable decision.
    const creditAccounts = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "billing_credit_accounts"
      WHERE "account_id" = ${subscription.accountId}
        AND "org_id" = ${subscription.orgId}
        AND ("team_id" = ${subscription.teamId} OR "team_id" IS NULL)
      ORDER BY "id" FOR UPDATE
    `);
    const confirmedSettlements = await tx.billingCreditUsageSettlement.findMany({
      where: {
        creditAccountId: { in: creditAccounts.map((row) => row.id) },
        serviceId: subscription.serviceId,
        billingMonth: params.billingMonth,
        ...(subscription.teamId ? { teamId: subscription.teamId } : {}),
      },
      select: { cumulativeCreditsConsumedMicrocredits: true },
    });
    const confirmedOffset = confirmedSettlements.reduce(
      (sum, row) => sum + row.cumulativeCreditsConsumedMicrocredits / 10n, 0n,
    );
    if (confirmedOffset !== params.creditOffsetMicroMinor) {
      throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_ALLOCATION_CHANGED_DURING_EXPORT');
    }
    const grossCharges = validatedStripeCumulativeCharges(params.usage, subscription);
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
      grossCharges.set(
        key,
        grossCharges.get(key) ?? {
          billingProduct: previous.billingProduct,
          callerProduct: previous.callerProduct,
          currency: previous.currency,
          amount: '0',
          quantity: 0n,
        },
      );
    }
    const charges = applyCreditOffsetToStripeCharges(
      grossCharges,
      params.creditOffsetMicroMinor,
      latestByKey,
    );

    let payerVersionAdvanced = false;
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
      if (delta < 0n) {
        throw new AppError('INTERNAL', 409, 'STRIPE_METER_NEGATIVE_CORRECTION_REQUIRES_RECONCILIATION');
      }
      // Credit settlement uses SERIALIZABLE isolation. A waiter can acquire
      // this lock after our commit while retaining a snapshot from before the
      // export. Advance the payer row version once for a new reservation so
      // that settlement retries against the newly reserved liability.
      if (!payerVersionAdvanced && creditAccounts.length > 0) {
        await tx.billingCreditAccount.updateMany({
          where: { id: { in: creditAccounts.map((row) => row.id) } },
          data: { updatedAt: new Date() },
        });
        payerVersionAdvanced = true;
      }
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
          cumulativeGrossMeterQuantity: grossCharges.get(key)?.quantity ?? charge.quantity,
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
        stripeMeterEventState: { not: BillingStripeMeterEventState.MANUAL_SETTLED },
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
    if (row.stripeMeterEventState === BillingStripeMeterEventState.RECONCILIATION_REQUIRED) {
      throw new AppError('INTERNAL', 409, 'STRIPE_METER_EVENT_RECONCILIATION_REQUIRED');
    }
    const firstAttemptAge = row.stripeMeterEventFirstAttemptedAt
      ? params.now.getTime() - row.stripeMeterEventFirstAttemptedAt.getTime()
      : null;
    const lastAttemptAge = row.stripeMeterEventAttemptedAt
      ? params.now.getTime() - row.stripeMeterEventAttemptedAt.getTime()
      : null;
    if (firstAttemptAge !== null && firstAttemptAge >= METER_EVENT_SAFE_RETRY_MS) {
      await prisma.billingStripeUsageExport.updateMany({
        where: {
          id: row.id,
          stripeMeterEventCreatedAt: null,
          stripeMeterEventState: BillingStripeMeterEventState.UNCERTAIN,
        },
        data: { stripeMeterEventState: BillingStripeMeterEventState.RECONCILIATION_REQUIRED },
      });
      throw new AppError('INTERNAL', 409, 'STRIPE_METER_EVENT_RECONCILIATION_REQUIRED');
    }
    if (lastAttemptAge !== null && lastAttemptAge < METER_EVENT_RETRY_DELAY_MS) {
      throw new AppError('INTERNAL', 409, 'STRIPE_METER_EVENT_DELIVERY_UNCERTAIN');
    }
    // Reserve the attempt durably before contacting Stripe. A crash after
    // acceptance but before the sent marker remains an uncertain attempt.
    const claimed = await prisma.billingStripeUsageExport.updateMany({
      where: {
        id: row.id,
        stripeMeterEventCreatedAt: null,
        stripeMeterEventState: row.stripeMeterEventState,
        stripeMeterEventAttemptedAt: row.stripeMeterEventAttemptedAt,
        stripeMeterEventFirstAttemptedAt: row.stripeMeterEventFirstAttemptedAt,
        stripeMeterEventIdentifier: row.stripeMeterEventIdentifier,
        stripeMeterEventAttemptGeneration: row.stripeMeterEventAttemptGeneration,
      },
      data: {
        stripeMeterEventAttemptedAt: params.now,
        stripeMeterEventFirstAttemptedAt: row.stripeMeterEventFirstAttemptedAt ?? params.now,
        stripeMeterEventState: BillingStripeMeterEventState.UNCERTAIN,
      },
    });
    if (claimed.count !== 1) {
      throw new AppError('INTERNAL', 409, 'STRIPE_METER_EVENT_DELIVERY_UNCERTAIN');
    }
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
    const accepted = await prisma.billingStripeUsageExport.updateMany({
      where: {
        id: row.id,
        stripeMeterEventCreatedAt: null,
        stripeMeterEventState: BillingStripeMeterEventState.UNCERTAIN,
        stripeMeterEventIdentifier: row.stripeMeterEventIdentifier,
        stripeMeterEventAttemptGeneration: row.stripeMeterEventAttemptGeneration,
        stripeMeterEventAttemptedAt: params.now,
      },
      data: {
        stripeMeterEventCreatedAt: new Date(event.created * 1000),
        stripeMeterEventState: BillingStripeMeterEventState.ACCEPTED,
      },
    });
    if (accepted.count !== 1) {
      throw new AppError('INTERNAL', 409, 'STRIPE_METER_EVENT_ACCEPTANCE_UNCERTAIN');
    }
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
    fetchUsage?: typeof fetchLedgerMeteringUsage;
    settleCredits?: typeof settleSubscriptionCreditLiability;
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
      serviceId: true,
      tariffId: true,
      tariff: { select: { usagePaymentMode: true } },
      service: { select: { identifier: true } },
    },
  });
  if (!subscription) {
    throw new AppError('NOT_FOUND', 404, 'STRIPE_SUBSCRIPTION_NOT_FOUND');
  }
  stripeUsageMonthBounds(params.billingMonth);
  const usage = await (deps?.fetchUsage ?? fetchLedgerMeteringUsage)({
    product: subscription.service.identifier,
    organisationId: subscription.orgId,
    teamId: subscription.teamId,
    billingMonth: params.billingMonth,
    groupBy: 'service',
    cursor: params.cursor,
  });
  const now = deps?.now?.() ?? new Date();
  stripeUsageMeterTimestamp(new Date(usage.snapshot.capturedAt), params.billingMonth, now);
  if (subscription.tariff.usagePaymentMode === BillingUsagePaymentMode.PREPAID) {
    await assertPrepaidUsageCovered({ usage, serviceId: subscription.serviceId,
      product: subscription.service.identifier, organisationId: subscription.orgId,
      teamId: subscription.teamId, billingMonth: params.billingMonth }, prisma);
    const prior = await prisma.billingStripeUsageExport.count({
      where: { subscriptionId: subscription.id, billingMonth: params.billingMonth },
    });
    if (prior !== 0) throw new AppError('INTERNAL', 409, 'PREPAID_STRIPE_EXPORT_CONFLICT');
    return { ledgerSnapshotCursor: usage.snapshot.cursor,
      billingMonth: params.billingMonth, exports: [] };
  }
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
  const creditOffsetMicroMinor = await (
    deps?.settleCredits ?? settleSubscriptionCreditLiability
  )({ subscription, account, billingMonth: params.billingMonth }, { prisma });
  const prepared = await prepareExports(
    {
      subscriptionId: subscription.id,
      billingMonth: params.billingMonth,
      usage,
      creditOffsetMicroMinor,
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
