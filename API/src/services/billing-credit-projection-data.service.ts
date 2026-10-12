import {
  BillingCreditAutoTopUpAttemptStatus,
  BillingCreditCheckoutStatus,
  BillingCreditEntryDirection,
  BillingCreditEntryKind,
  type PrismaClient,
} from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { billingReservedMicrocredits } from './billing-credit-holds.service.js';
import type { CreditPurchaseCurrency } from './billing-stripe-catalog-provisioning-spec.js';

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
    teamId: string;
    accountId: string;
    storefrontServiceId: string;
    period: BillingCreditPeriod;
    /** The currency top-ups are offered in: the billing region's, or USD. */
    purchaseCurrency?: CreditPurchaseCurrency;
    /** The currency reload options are offered in (credits protocol 2.2.0): the region's, or USD. */
    reloadCurrency?: CreditPurchaseCurrency;
  },
  deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const purchaseCurrency = params.purchaseCurrency ?? 'USD';
  const reloadCurrency = params.reloadCurrency ?? 'USD';
  const regionCurrency = purchaseCurrency !== 'USD' ? purchaseCurrency : reloadCurrency;
  const [
    creditAccount,
    policy,
    regionPolicy,
    catalogs,
    settlements,
    prepaidReservations,
    activeReserved,
    entries,
    pendingCheckouts,
    pendingSetupCheckouts,
    pendingAttempts,
  ] = await Promise.all([
    prisma.billingCreditAccount.findUnique({
      where: { id: params.creditAccountId },
      include: {
        autoTopUpConsentedBy: { select: { id: true, name: true } },
        customer: { select: { stripeCustomerId: true } },
      },
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
    regionCurrency === 'USD' ? null : prisma.billingCreditFundingPolicy.findFirst({
      where: { serviceId: params.storefrontServiceId, currency: regionCurrency, active: true },
      orderBy: { version: 'desc' },
      include: {
        topUpOffers: { where: { active: true }, orderBy: [{ paymentAmountMinor: 'asc' }, { key: 'asc' }] },
        autoTopUpOptions: { where: { active: true },
          orderBy: [{ monthlyChargeCapMinor: 'asc' }, { key: 'asc' }], include: { refillOffer: true } },
      },
    }),
    prisma.billingCreditTopUpCatalog.findMany({
      where: { accountId: params.accountId, currency: { in: [...new Set(['USD', regionCurrency])] } },
    }),
    prisma.billingCreditUsageSettlement.findMany({
      where: {
        creditAccountId: params.creditAccountId,
        teamId: params.teamId,
        billingMonth: params.period.key,
      },
      orderBy: { service: { identifier: 'asc' } },
      include: { service: true },
    }),
    prisma.billingPrepaidReservation.findMany({
      where: { creditAccountId: params.creditAccountId, teamId: params.teamId,
        billingMonth: params.period.key },
      include: { tariff: { select: { service: { select: { id: true,
        identifier: true, name: true } } } } },
    }),
    billingReservedMicrocredits(prisma, params.creditAccountId),
    prisma.billingCreditEntry.findMany({
      where: { creditAccountId: params.creditAccountId,
        OR: [{ kind: { notIn: [BillingCreditEntryKind.PREPAID_USAGE, BillingCreditEntryKind.SMS_PREPAID_USAGE] } },
          { prepaidReservation: { teamId: params.teamId } },
          { smsReservation: { teamId: params.teamId } },
          { smsInboundReceipt: { teamId: params.teamId } }] },
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
        status: {
          in: [
            BillingCreditCheckoutStatus.CREATING,
            BillingCreditCheckoutStatus.OPEN,
            BillingCreditCheckoutStatus.NEEDS_REVIEW,
          ],
        },
      },
      select: {
        id: true,
        accountId: true,
        creditAccountId: true,
        customerId: true,
        catalogId: true,
        serviceId: true,
        appKeyId: true,
        offerId: true,
        paymentAmountMinor: true,
        creditsReceivedMicrocredits: true,
        currency: true,
        successUrlDigest: true,
        cancelUrlDigest: true,
        status: true,
        stripeCheckoutSessionId: true,
      },
    }),
    prisma.billingCreditSetupCheckout.findMany({
      where: {
        creditAccountId: params.creditAccountId,
        status: {
          in: [
            BillingCreditCheckoutStatus.CREATING,
            BillingCreditCheckoutStatus.OPEN,
            BillingCreditCheckoutStatus.NEEDS_REVIEW,
          ],
        },
      },
      select: { id: true },
    }),
    prisma.billingCreditAutoTopUpAttempt.findMany({
      where: {
        creditAccountId: params.creditAccountId,
        status: {
          in: [
            BillingCreditAutoTopUpAttemptStatus.PENDING,
            BillingCreditAutoTopUpAttemptStatus.PROCESSING,
            BillingCreditAutoTopUpAttemptStatus.REQUIRES_ACTION,
            BillingCreditAutoTopUpAttemptStatus.NEEDS_REVIEW,
          ],
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        creditAccountId: true,
        catalogId: true,
        serviceId: true,
        appKeyId: true,
        status: true,
        stripePaymentIntentId: true,
        failureCode: true,
        paymentAmountMinor: true,
        creditsReceivedMicrocredits: true,
        currency: true,
        consentRevision: { select: { stripePaymentMethodId: true } },
        stateWebhookEvent: { select: { type: true } },
      },
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
    // Automatic top-up stays on the USD policy; one-time top-ups use the purchase currency's.
    policy,
    purchaseCurrency,
    reloadCurrency,
    regionPolicy,
    catalogs,
    settlements,
    prepaidReservations,
    activeReservedMicrocredits: activeReserved,
    allocations,
    entries,
    periodEntries,
    pending: [...pendingCheckouts, ...pendingAttempts],
    unresolvedTopUpCheckouts: pendingCheckouts,
    unresolvedSetupCheckouts: pendingSetupCheckouts,
    unresolvedAttempts: pendingAttempts,
    autoTopUpChargedMinor: successfulAutoTopUps._sum.paymentAmountMinor ?? 0n,
  };
}

export type BillingCreditProjectionData = Awaited<
  ReturnType<typeof loadBillingCreditProjectionData>
>;

/** The policy reload options are offered under: the USD policy, or the region currency's. */
export function creditReloadPolicy(
  data: Pick<BillingCreditProjectionData, 'policy' | 'reloadCurrency' | 'regionPolicy'>,
) {
  return data.reloadCurrency === 'USD' ? data.policy : data.regionPolicy;
}

/** The policy one-time top-ups are offered under: the USD policy, or the region currency's. */
export function creditPurchasePolicy(
  data: Pick<BillingCreditProjectionData, 'policy' | 'purchaseCurrency' | 'regionPolicy'>,
) {
  return data.purchaseCurrency === 'USD' ? data.policy : data.regionPolicy;
}
