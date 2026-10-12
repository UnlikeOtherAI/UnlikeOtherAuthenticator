import {
  BillingAppKeyPurpose,
  BillingAssignmentScope,
  BillingCreditAutoTopUpAttemptStatus,
  BillingCreditAutoTopUpState,
  BillingCreditEntryDirection,
  BillingCreditEntryKind,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { billingReservedMicrocredits } from './billing-credit-holds.service.js';
import { creditBalanceValue, creditValueTarget } from './billing-credit-lot-value.service.js';
import {
  creditsForPayment,
  readCreditPurchaseRateWithAlert,
  type CreditPurchaseRateClient,
} from './billing-credit-purchase-rate.service.js';
import type { CreditPurchaseCurrency } from './billing-stripe-catalog-provisioning-spec.js';

const OPEN_ATTEMPT_STATUSES = [
  BillingCreditAutoTopUpAttemptStatus.PENDING,
  BillingCreditAutoTopUpAttemptStatus.PROCESSING,
  BillingCreditAutoTopUpAttemptStatus.REQUIRES_ACTION,
  BillingCreditAutoTopUpAttemptStatus.NEEDS_REVIEW,
] as const;

export type CreditAutoTopUpClaim =
  | {
      kind: 'dispatch';
      creditAccountId: string;
      attemptId: string;
      created: boolean;
    }
  | {
      kind: 'awaiting_webhook';
      creditAccountId: string;
      attemptId: string;
      stripePaymentIntentId: string | null;
    }
  | {
      kind: 'skipped';
      creditAccountId: string;
      reason:
        | 'account_not_found'
        | 'configuration_inactive'
        | 'configuration_invalid'
        | 'monthly_cap_reached'
        | 'threshold_not_reached'
        | 'value_unavailable'
        | 'rate_unavailable';
    };

export type CreditAutoTopUpWebhookCandidate = {
  attemptId: string;
  creditAccountId: string;
  stripePaymentIntentId: string | null;
  createdAt: Date;
};

type BillingClock = {
  billingMonth: string;
  currentTime: Date;
};

async function lockCreditAccount(
  tx: Prisma.TransactionClient,
  creditAccountId: string,
): Promise<boolean> {
  await tx.$queryRaw(Prisma.sql`
    WITH account_lock AS (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`credit-auto-top-up:${creditAccountId}`}, 0)
      )
    )
    SELECT 1::integer AS "locked" FROM account_lock
  `);
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "billing_credit_accounts"
    WHERE "id" = ${creditAccountId}
    FOR UPDATE
  `);
  return rows.length === 1;
}

function activeConfigurationIsExact(
  credit: NonNullable<Awaited<ReturnType<typeof loadCreditConfiguration>>>,
  accountId: string,
  currentTime: Date,
): boolean {
  const revision = credit.autoTopUpConsentRevision;
  const policy = credit.autoTopUpPolicy;
  const option = credit.autoTopUpOption;
  const offer = credit.autoTopUpRefillOffer;
  const appKey = credit.autoTopUpAppKey;
  const customer = credit.customer;
  return Boolean(
    revision &&
    policy &&
    option &&
    offer &&
    appKey &&
    credit.accountId === accountId &&
    credit.currency === 'USD' &&
    credit.autoTopUpState === BillingCreditAutoTopUpState.ACTIVE &&
    customer.accountId === accountId &&
    customer.orgId === credit.orgId &&
    customer.teamId === credit.teamId &&
    customer.scope === BillingAssignmentScope.TEAM &&
    customer.scopeKey === `${credit.orgId}:${credit.teamId}` &&
    Boolean(customer.stripeCustomerId) &&
    credit.autoTopUpPolicyId === policy.id &&
    credit.autoTopUpServiceId === policy.serviceId &&
    credit.autoTopUpAppKeyId === appKey.id &&
    credit.autoTopUpConsentRevisionId === revision.id &&
    credit.autoTopUpOptionId === option.id &&
    credit.autoTopUpRefillOfferId === offer.id &&
    credit.autoTopUpThresholdMicrocredits === revision.thresholdMicrocredits &&
    credit.autoTopUpMonthlyChargeCapMinor === revision.monthlyChargeCapMinor &&
    credit.autoTopUpConsentVersion === revision.consentVersion &&
    credit.autoTopUpConsentedAt?.getTime() === revision.consentedAt.getTime() &&
    credit.autoTopUpConsentedByUserId === revision.consentedByUserId &&
    credit.stripePaymentMethodId === revision.stripePaymentMethodId &&
    revision.accountId === accountId &&
    revision.creditAccountId === credit.id &&
    revision.orgId === credit.orgId &&
    revision.teamId === credit.teamId &&
    revision.serviceId === policy.serviceId &&
    revision.appKeyId === appKey.id &&
    revision.policyId === policy.id &&
    revision.optionId === option.id &&
    revision.refillOfferId === offer.id &&
    ['USD', 'EUR', 'GBP'].includes(policy.currency) &&
    policy.active &&
    policy.automaticTopUpEnabled &&
    policy.automaticConsentVersion === revision.consentVersion &&
    option.active &&
    option.policyId === policy.id &&
    option.serviceId === policy.serviceId &&
    option.refillOfferId === offer.id &&
    option.thresholdMicrocredits === revision.thresholdMicrocredits &&
    option.thresholdAmountMinor === revision.thresholdAmountMinor &&
    option.monthlyChargeCapMinor === revision.monthlyChargeCapMinor &&
    offer.active &&
    offer.policyId === policy.id &&
    offer.serviceId === policy.serviceId &&
    offer.automaticTopUpEligible &&
    offer.paymentAmountMinor === revision.refillPaymentAmountMinor &&
    offer.creditsReceivedMicrocredits === revision.refillCreditsMicrocredits &&
    appKey.serviceId === policy.serviceId &&
    appKey.purpose === BillingAppKeyPurpose.CUSTOMER_LIFECYCLE &&
    !appKey.revokedAt &&
    (!appKey.expiresAt || appKey.expiresAt > currentTime),
  );
}

function loadCreditConfiguration(tx: Prisma.TransactionClient, creditAccountId: string) {
  return tx.billingCreditAccount.findUnique({
    where: { id: creditAccountId },
    include: {
      customer: true,
      autoTopUpPolicy: true,
      autoTopUpAppKey: true,
      autoTopUpConsentRevision: true,
      autoTopUpOption: true,
      autoTopUpRefillOffer: true,
    },
  });
}

async function billingClock(tx: Prisma.TransactionClient): Promise<BillingClock> {
  const rows = await tx.$queryRaw<BillingClock[]>(Prisma.sql`
    SELECT
      to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM') AS "billingMonth",
      CURRENT_TIMESTAMP AS "currentTime"
  `);
  if (rows.length !== 1) throw new Error('BILLING_CREDIT_AUTO_TOP_UP_CLOCK_UNAVAILABLE');
  return rows[0];
}

export async function listCreditAutoTopUpCandidateIds(
  params: { accountId: string; limit: number },
  deps: { prisma: PrismaClient },
): Promise<string[]> {
  const rows = await deps.prisma.$queryRaw<Array<{ creditAccountId: string }>>(Prisma.sql`
    SELECT candidate."creditAccountId"
    FROM (
      SELECT
        attempt."credit_account_id" AS "creditAccountId",
        0::integer AS "priority"
      FROM "billing_credit_auto_top_up_attempts" AS attempt
      WHERE attempt."account_id" = ${params.accountId}
        AND attempt."status" = 'PENDING'
        AND attempt."stripe_payment_intent_id" IS NULL
      UNION ALL
      SELECT
        attempt."credit_account_id" AS "creditAccountId",
        1::integer AS "priority"
      FROM "billing_credit_auto_top_up_attempts" AS attempt
      WHERE attempt."account_id" = ${params.accountId}
        AND attempt."status" IN ('PENDING', 'PROCESSING', 'REQUIRES_ACTION', 'NEEDS_REVIEW')
        AND attempt."stripe_payment_intent_id" IS NOT NULL
      UNION ALL
      SELECT
        credit."id" AS "creditAccountId",
        2::integer AS "priority"
      FROM "billing_credit_accounts" AS credit
      WHERE credit."account_id" = ${params.accountId}
        AND credit."currency" = 'USD'
        AND credit."auto_top_up_state" = 'ACTIVE'
        AND credit."auto_top_up_threshold_microcredits" IS NOT NULL
        -- A GBP or EUR threshold is a value the claim computes from the lots.
        AND (credit."balance_microcredits" < credit."auto_top_up_threshold_microcredits"
          OR EXISTS (SELECT 1 FROM "billing_credit_auto_top_up_consent_revisions" AS revision
            WHERE revision."id" = credit."auto_top_up_consent_revision_id"
              AND revision."threshold_amount_minor" IS NOT NULL))
        AND NOT EXISTS (
          SELECT 1
          FROM "billing_credit_auto_top_up_attempts" AS attempt
          WHERE attempt."credit_account_id" = credit."id"
            AND attempt."status" IN ('PENDING', 'PROCESSING', 'REQUIRES_ACTION', 'NEEDS_REVIEW')
        )
    ) AS candidate
    ORDER BY candidate."priority", candidate."creditAccountId"
    LIMIT ${params.limit}
  `);
  return rows.map((row) => row.creditAccountId);
}

export async function listCreditAutoTopUpWebhookCandidates(
  params: { accountId: string; creditAccountIds: string[]; limit: number },
  deps: { prisma: PrismaClient },
): Promise<CreditAutoTopUpWebhookCandidate[]> {
  if (params.creditAccountIds.length === 0) return [];
  const attempts = await deps.prisma.billingCreditAutoTopUpAttempt.findMany({
    where: {
      accountId: params.accountId,
      creditAccountId: { in: params.creditAccountIds },
      status: { in: [...OPEN_ATTEMPT_STATUSES] },
    },
    select: {
      id: true,
      creditAccountId: true,
      stripePaymentIntentId: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: params.limit,
  });
  return attempts.map((attempt) => ({
    attemptId: attempt.id,
    creditAccountId: attempt.creditAccountId,
    stripePaymentIntentId: attempt.stripePaymentIntentId,
    createdAt: attempt.createdAt,
  }));
}

/** What the lots are worth in a GBP or EUR reload's currency, under the claim's lock. */
async function reloadValueMinor(tx: Prisma.TransactionClient, credit: { id: string; orgId: string },
  currency: CreditPurchaseCurrency, stripe: CreditPurchaseRateClient | null): Promise<bigint | null> {
  const [lots, debt, reserved, target] = await Promise.all([
    tx.billingCreditLot.findMany({ where: { creditAccountId: credit.id, remainingMicrocredits: { gt: 0 } },
      select: { currency: true, usdPerUnit: true, remainingMicrocredits: true, sequence: true } }),
    tx.billingCreditLotMovement.aggregate({ where: { creditAccountId: credit.id, lotId: null },
      _sum: { deltaMicrocredits: true } }),
    billingReservedMicrocredits(tx, credit.id),
    creditValueTarget(credit.orgId, { db: tx, stripe }),
  ]);
  if (target.currency !== currency) return null;
  return creditBalanceValue({ lots, debtMicrocredits: -(debt._sum.deltaMicrocredits ?? 0n),
    reservedMicrocredits: reserved, target })?.amountMinor ?? null;
}

export async function claimCreditAutoTopUpAttempt(
  params: { accountId: string; creditAccountId: string },
  deps: { prisma: PrismaClient; createId?: () => string; stripe?: CreditPurchaseRateClient | null;
    readRate?: typeof readCreditPurchaseRateWithAlert },
): Promise<CreditAutoTopUpClaim> {
  return deps.prisma.$transaction(async (tx) => {
    if (!(await lockCreditAccount(tx, params.creditAccountId))) {
      return {
        kind: 'skipped',
        creditAccountId: params.creditAccountId,
        reason: 'account_not_found',
      };
    }
    const unresolved = await tx.billingCreditAutoTopUpAttempt.findFirst({
      where: {
        creditAccountId: params.creditAccountId,
        status: { in: [...OPEN_ATTEMPT_STATUSES] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (unresolved) {
      if (
        unresolved.status === BillingCreditAutoTopUpAttemptStatus.PENDING &&
        !unresolved.stripePaymentIntentId
      ) {
        return {
          kind: 'dispatch',
          creditAccountId: params.creditAccountId,
          attemptId: unresolved.id,
          created: false,
        };
      }
      return {
        kind: 'awaiting_webhook',
        creditAccountId: params.creditAccountId,
        attemptId: unresolved.id,
        stripePaymentIntentId: unresolved.stripePaymentIntentId,
      };
    }

    const [credit, clock] = await Promise.all([
      loadCreditConfiguration(tx, params.creditAccountId),
      billingClock(tx),
    ]);
    if (!credit) {
      return {
        kind: 'skipped',
        creditAccountId: params.creditAccountId,
        reason: 'account_not_found',
      };
    }
    const currency = (credit.autoTopUpPolicy?.currency ?? 'USD') as CreditPurchaseCurrency;
    if (
      credit.autoTopUpState !== BillingCreditAutoTopUpState.ACTIVE ||
      credit.autoTopUpThresholdMicrocredits === null ||
      (currency === 'USD' && credit.balanceMicrocredits >= credit.autoTopUpThresholdMicrocredits)
    ) {
      return {
        kind: 'skipped',
        creditAccountId: credit.id,
        reason:
          credit.autoTopUpState === BillingCreditAutoTopUpState.ACTIVE
            ? 'threshold_not_reached'
            : 'configuration_inactive',
      };
    }
    if (!activeConfigurationIsExact(credit, params.accountId, clock.currentTime)) {
      return { kind: 'skipped', creditAccountId: credit.id, reason: 'configuration_invalid' };
    }
    const revision = credit.autoTopUpConsentRevision;
    const offer = credit.autoTopUpRefillOffer;
    if (!revision || !offer) {
      return { kind: 'skipped', creditAccountId: credit.id, reason: 'configuration_invalid' };
    }
    const catalog = await tx.billingCreditTopUpCatalog.findUnique({
      where: {
        accountId_key_version: {
          accountId: params.accountId,
          key: offer.catalogKey,
          version: offer.catalogVersion,
        },
      },
    });
    if (
      !catalog?.stripePriceId ||
      catalog.currency !== currency ||
      catalog.paymentAmountMinor !== revision.refillPaymentAmountMinor ||
      catalog.creditsReceivedMicrocredits !== revision.refillCreditsMicrocredits
    ) {
      return { kind: 'skipped', creditAccountId: credit.id, reason: 'configuration_invalid' };
    }
    // A GBP or EUR reload compares the lots' value in its currency with its threshold.
    let observedValueMinor: bigint | null = null;
    if (currency !== 'USD') {
      if (revision.thresholdAmountMinor === null) {
        return { kind: 'skipped', creditAccountId: credit.id, reason: 'configuration_invalid' };
      }
      observedValueMinor = await reloadValueMinor(tx, credit, currency, deps.stripe ?? null);
      if (observedValueMinor === null) {
        return { kind: 'skipped', creditAccountId: credit.id, reason: 'value_unavailable' };
      }
      if (observedValueMinor >= revision.thresholdAmountMinor) {
        return { kind: 'skipped', creditAccountId: credit.id, reason: 'threshold_not_reached' };
      }
    }
    const charged = await tx.billingCreditAutoTopUpAttempt.aggregate({
      where: {
        creditAccountId: credit.id,
        billingMonth: clock.billingMonth,
        status: BillingCreditAutoTopUpAttemptStatus.SUCCEEDED,
      },
      _sum: { paymentAmountMinor: true },
    });
    const chargedBefore = charged._sum.paymentAmountMinor ?? 0n;
    if (chargedBefore + revision.refillPaymentAmountMinor > revision.monthlyChargeCapMinor) {
      return { kind: 'skipped', creditAccountId: credit.id, reason: 'monthly_cap_reached' };
    }
    const latestEntry = await tx.billingCreditEntry.findFirst({
      where: { creditAccountId: credit.id },
      select: { id: true, direction: true, kind: true, balanceAfterMicrocredits: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const exactUsageTrigger =
      latestEntry?.direction === BillingCreditEntryDirection.DEBIT &&
      (latestEntry.kind === BillingCreditEntryKind.USAGE_SETTLEMENT ||
        latestEntry.kind === BillingCreditEntryKind.USAGE_SETTLEMENT_CORRECTION) &&
      latestEntry.balanceAfterMicrocredits === credit.balanceMicrocredits
        ? latestEntry.id
        : null;
    // A GBP or EUR reload buys credits at the live rate read now, just before its PaymentIntent.
    let reload: { credits: bigint; fx: { fxRateSource: string; fxBaseRate: string; fxExchangeRate: string | null;
      fxQuoteId: string | null; fxSnapshotId: string | null } | null } =
      { credits: revision.refillCreditsMicrocredits, fx: null };
    if (currency !== 'USD') {
      if (!deps.stripe) return { kind: 'skipped', creditAccountId: credit.id, reason: 'rate_unavailable' };
      try {
        const rate = await (deps.readRate ?? readCreditPurchaseRateWithAlert)(currency,
          { stripe: deps.stripe, prisma: tx as unknown as PrismaClient });
        reload = { credits: creditsForPayment(revision.refillPaymentAmountMinor, rate.baseRate), fx: {
          fxRateSource: rate.source, fxBaseRate: rate.baseRate, fxExchangeRate: rate.exchangeRate,
          fxQuoteId: rate.quoteId, fxSnapshotId: rate.fxSnapshotId,
        } };
      } catch {
        return { kind: 'skipped', creditAccountId: credit.id, reason: 'rate_unavailable' };
      }
      if (reload.credits <= 0n) return { kind: 'skipped', creditAccountId: credit.id, reason: 'rate_unavailable' };
    }
    const attemptId = deps.createId?.() ?? randomUUID();
    const attempt = await tx.billingCreditAutoTopUpAttempt.create({
      data: {
        id: attemptId,
        accountId: params.accountId,
        creditAccountId: credit.id,
        catalogId: catalog.id,
        serviceId: revision.serviceId,
        appKeyId: revision.appKeyId,
        attributedUserId: revision.consentedByUserId,
        optionId: revision.optionId,
        offerId: revision.refillOfferId,
        triggerEntryId: exactUsageTrigger,
        consentRevisionId: revision.id,
        consentVersion: revision.consentVersion,
        thresholdMicrocredits: revision.thresholdMicrocredits,
        monthlyChargeCapMinor: revision.monthlyChargeCapMinor,
        chargedThisMonthBeforeMinor: chargedBefore,
        observedBalanceMicrocredits: credit.balanceMicrocredits,
        paymentAmountMinor: revision.refillPaymentAmountMinor,
        creditsReceivedMicrocredits: reload.credits,
        currency,
        thresholdAmountMinor: revision.thresholdAmountMinor,
        observedValueMinor,
        ...(reload.fx ?? {}),
        billingMonth: clock.billingMonth,
        idempotencyKey: `uoa:auto-top-up:${attemptId}`,
      },
    });
    return {
      kind: 'dispatch',
      creditAccountId: credit.id,
      attemptId: attempt.id,
      created: true,
    };
  });
}
