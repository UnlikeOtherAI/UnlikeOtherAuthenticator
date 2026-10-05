import { BillingUsagePaymentMode, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { fetchLedgerMeteringUsage } from './billing-ledger-collector.service.js';
import { settleSubscriptionCreditLiability } from './billing-credit-liability.service.js';
import { assertPrepaidUsageCovered } from './billing-prepaid-coverage.service.js';
import {
  applyCreditOffsetToStripeCharges,
  stripeUsageChargeKey,
  stripeUsageSubscriptionInclude,
  validatedStripeCumulativeCharges,
} from './billing-stripe-usage-validation.service.js';

/** Measures only net UOA liability that has no reserved Stripe meter row. */
export async function quoteUnexportedClosedPeriodLiability(
  params: {
    subscriptionId: string;
    billingMonth: string;
    invoicedUsageAmountMinor?: bigint;
    paidAdjustmentsAmountMinor?: bigint;
  },
  deps?: {
    prisma?: PrismaClient;
    fetchUsage?: typeof fetchLedgerMeteringUsage;
    settleCredits?: typeof settleSubscriptionCreditLiability;
  },
): Promise<{ ledgerSnapshotCursor: string; amountMicroMinor: bigint; currency: string }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const subscription = await prisma.billingStripeSubscription.findUniqueOrThrow({
    where: { id: params.subscriptionId }, include: stripeUsageSubscriptionInclude,
  });
  const usage = await (deps?.fetchUsage ?? fetchLedgerMeteringUsage)({
    product: subscription.service.identifier,
    organisationId: subscription.orgId,
    teamId: subscription.teamId,
    billingMonth: params.billingMonth,
    groupBy: 'service',
  });
  if (usage.scope.month !== params.billingMonth ||
      usage.scope.organizationId !== subscription.orgId ||
      usage.scope.teamId !== subscription.teamId) {
    throw new AppError('INTERNAL', 502, 'LEDGER_BILLING_SCOPE_MISMATCH');
  }
  if (subscription.tariff.usagePaymentMode === BillingUsagePaymentMode.PREPAID) {
    await assertPrepaidUsageCovered({ usage, serviceId: subscription.serviceId,
      product: subscription.service.identifier, organisationId: subscription.orgId,
      teamId: subscription.teamId, billingMonth: params.billingMonth }, prisma);
    const prior = await prisma.billingStripeUsageExport.count({
      where: { subscriptionId: subscription.id, billingMonth: params.billingMonth },
    });
    if (prior !== 0) throw new AppError('INTERNAL', 409, 'PREPAID_STRIPE_EXPORT_CONFLICT');
    return { ledgerSnapshotCursor: usage.snapshot.cursor,
      amountMicroMinor: 0n, currency: subscription.tariff.currency };
  }
  const offset = await (deps?.settleCredits ?? settleSubscriptionCreditLiability)({
    subscription,
    account: subscription.account,
    billingMonth: params.billingMonth,
  }, { prisma });
  const previousRows = await prisma.billingStripeUsageExport.findMany({
    where: { subscriptionId: subscription.id, billingMonth: params.billingMonth },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const previous = new Map<string, typeof previousRows[number]>();
  for (const row of previousRows) {
    const key = stripeUsageChargeKey(row.callerProduct, row.currency);
    if (!previous.has(key)) previous.set(key, row);
  }
  const gross = validatedStripeCumulativeCharges(usage, subscription);
  for (const [key, prior] of previous) {
    if (!gross.has(key)) gross.set(key, {
      billingProduct: prior.billingProduct,
      callerProduct: prior.callerProduct,
      currency: prior.currency,
      amount: '0',
      quantity: 0n,
    });
  }
  const net = applyCreditOffsetToStripeCharges(gross, offset, previous);
  let targetNetMicroMinor = 0n;
  let reservedNetMicroMinor = 0n;
  for (const [key, item] of net) {
    const reserved = previous.get(key)?.cumulativeMeterQuantity ?? 0n;
    const delta = item.quantity - reserved;
    if (delta < 0n) {
      throw new AppError('INTERNAL', 409, 'STRIPE_CLOSED_PERIOD_CORRECTION_REQUIRED');
    }
    targetNetMicroMinor += item.quantity;
    reservedNetMicroMinor += reserved;
  }
  const billedMicroMinor = params.invoicedUsageAmountMinor === undefined
    ? reservedNetMicroMinor : params.invoicedUsageAmountMinor * 1_000_000n;
  const compensatedMicroMinor = (params.paidAdjustmentsAmountMinor ?? 0n) * 1_000_000n;
  const difference = targetNetMicroMinor - billedMicroMinor - compensatedMicroMinor;
  if (difference < -500_000n) {
    throw new AppError('INTERNAL', 409, 'STRIPE_CLOSED_PERIOD_OVERBILLED');
  }
  const amountMicroMinor = difference <= 500_000n ? 0n : difference;
  return {
    ledgerSnapshotCursor: usage.snapshot.cursor,
    amountMicroMinor,
    currency: subscription.tariff.currency,
  };
}
