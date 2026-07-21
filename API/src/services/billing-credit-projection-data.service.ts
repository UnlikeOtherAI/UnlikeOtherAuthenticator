import {
  BillingCreditAutoTopUpAttemptStatus,
  BillingCreditCheckoutStatus,
  BillingCreditEntryDirection,
  BillingCreditEntryKind,
  type PrismaClient,
} from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

export type BillingCreditPeriod = {
  key: string;
  startsAt: Date;
  endsAt: Date;
};

export function currentBillingCreditPeriod(now: Date): BillingCreditPeriod {
  const startsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const endsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    key: `${startsAt.getUTCFullYear()}-${String(startsAt.getUTCMonth() + 1).padStart(2, '0')}`,
    startsAt,
    endsAt,
  };
}

export async function loadBillingCreditProjectionData(
  params: {
    creditAccountId: string;
    accountId: string;
    storefrontServiceId: string;
    period: BillingCreditPeriod;
  },
  deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const [creditAccount, policy, catalogs, settlements, entries, pendingCheckouts, pendingAttempts] =
    await Promise.all([
      prisma.billingCreditAccount.findUnique({
        where: { id: params.creditAccountId },
        include: { autoTopUpConsentedBy: { select: { id: true, name: true } } },
      }),
      prisma.billingCreditFundingPolicy.findFirst({
        where: {
          serviceId: params.storefrontServiceId,
          currency: 'USD',
          active: true,
        },
        orderBy: { version: 'desc' },
        include: {
          topUpOffers: {
            where: { active: true },
            orderBy: [{ paymentAmountMinor: 'asc' }, { key: 'asc' }],
          },
          autoTopUpOptions: {
            where: { active: true },
            orderBy: [{ thresholdMicrocredits: 'asc' }, { key: 'asc' }],
            include: { refillOffer: true },
          },
        },
      }),
      prisma.billingCreditTopUpCatalog.findMany({
        where: { accountId: params.accountId, currency: 'USD' },
      }),
      prisma.billingCreditUsageSettlement.findMany({
        where: {
          creditAccountId: params.creditAccountId,
          billingMonth: params.period.key,
        },
        orderBy: { service: { identifier: 'asc' } },
        include: { service: true },
      }),
      prisma.billingCreditEntry.findMany({
        where: { creditAccountId: params.creditAccountId },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 20,
        include: {
          service: { select: { id: true, identifier: true, name: true } },
          attributedUser: { select: { id: true, name: true } },
        },
      }),
      prisma.billingCreditTopUpCheckout.findMany({
        where: {
          creditAccountId: params.creditAccountId,
          status: { in: [BillingCreditCheckoutStatus.CREATING, BillingCreditCheckoutStatus.OPEN] },
        },
        select: { paymentAmountMinor: true, creditsReceivedMicrocredits: true },
      }),
      prisma.billingCreditAutoTopUpAttempt.findMany({
        where: {
          creditAccountId: params.creditAccountId,
          status: {
            in: [
              BillingCreditAutoTopUpAttemptStatus.PENDING,
              BillingCreditAutoTopUpAttemptStatus.PROCESSING,
            ],
          },
        },
        select: { paymentAmountMinor: true, creditsReceivedMicrocredits: true },
      }),
    ]);
  if (
    !creditAccount ||
    creditAccount.accountId !== params.accountId ||
    creditAccount.currency !== 'USD'
  ) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_ACCOUNT_SCOPE_CONFLICT');
  }

  const settlementIds = settlements.map((settlement) => settlement.id);
  const [allocations, periodEntries, successfulAutoTopUps] = await Promise.all([
    settlementIds.length
      ? prisma.billingCreditUsageAllocation.findMany({
          where: { settlementId: { in: settlementIds } },
          orderBy: [{ adjustment: { sequence: 'desc' } }, { id: 'desc' }],
          include: {
            adjustment: { select: { sequence: true } },
            attributedUser: { select: { id: true, name: true } },
          },
        })
      : [],
    prisma.billingCreditEntry.findMany({
      where: {
        creditAccountId: params.creditAccountId,
        occurredAt: { gte: params.period.startsAt, lt: params.period.endsAt },
        OR: [
          {
            direction: BillingCreditEntryDirection.CREDIT,
            kind: {
              in: [
                BillingCreditEntryKind.TOP_UP,
                BillingCreditEntryKind.AUTOMATIC_TOP_UP,
                BillingCreditEntryKind.ADJUSTMENT,
              ],
            },
          },
          {
            kind: {
              in: [
                BillingCreditEntryKind.USAGE_SETTLEMENT,
                BillingCreditEntryKind.USAGE_SETTLEMENT_CORRECTION,
              ],
            },
          },
        ],
      },
      select: { direction: true, kind: true, amountMicrocredits: true },
    }),
    prisma.billingCreditAutoTopUpAttempt.aggregate({
      where: {
        creditAccountId: params.creditAccountId,
        billingMonth: params.period.key,
        status: BillingCreditAutoTopUpAttemptStatus.SUCCEEDED,
      },
      _sum: { paymentAmountMinor: true },
    }),
  ]);

  return {
    creditAccount,
    policy,
    catalogs,
    settlements,
    allocations,
    entries,
    periodEntries,
    pending: [...pendingCheckouts, ...pendingAttempts],
    autoTopUpChargedMinor: successfulAutoTopUps._sum.paymentAmountMinor ?? 0n,
  };
}

export type BillingCreditProjectionData = Awaited<
  ReturnType<typeof loadBillingCreditProjectionData>
>;
