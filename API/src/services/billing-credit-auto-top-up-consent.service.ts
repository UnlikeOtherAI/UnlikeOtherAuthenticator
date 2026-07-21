import {
  BillingCreditAutoTopUpAttemptStatus,
  BillingCreditAutoTopUpConsentSource,
  BillingCreditAutoTopUpState,
  BillingCreditCheckoutStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  assertCreditCatalogPrice,
  resolveCreditAutoTopUpOption,
  resolveCreditFundingActionContext,
  type CreditFundingActionRequest,
} from './billing-credit-funding-context.service.js';
import { creditPaymentMethodSummary } from './billing-credit-payment-method.service.js';
import { assertStripeObjectLivemode } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

type Dependencies = {
  prisma?: PrismaClient;
  now?: () => Date;
  resolveContext?: typeof resolveCreditFundingActionContext;
  resolveOption?: typeof resolveCreditAutoTopUpOption;
  validateCatalog?: typeof assertCreditCatalogPrice;
};

type LockedConsentSnapshot = {
  id: string;
  autoTopUpGeneration: number;
  autoTopUpConsentRevisionId: string | null;
  autoTopUpState: BillingCreditAutoTopUpState;
  stripePaymentMethodId: string | null;
};

async function lockConsentSnapshot(
  tx: Prisma.TransactionClient,
  creditAccountId: string,
): Promise<LockedConsentSnapshot> {
  const rows = await tx.$queryRaw<LockedConsentSnapshot[]>(Prisma.sql`
    SELECT
      "id",
      "auto_top_up_generation" AS "autoTopUpGeneration",
      "auto_top_up_consent_revision_id" AS "autoTopUpConsentRevisionId",
      "auto_top_up_state" AS "autoTopUpState",
      "stripe_payment_method_id" AS "stripePaymentMethodId"
    FROM "billing_credit_accounts"
    WHERE "id" = ${creditAccountId}
    FOR UPDATE
  `);
  const account = rows[0];
  if (!account) throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ACCOUNT_MISSING');
  return account;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2002';
}

function assertConsentReplay(
  revision: {
    accountId: string;
    creditAccountId: string;
    orgId: string;
    teamId: string;
    serviceId: string;
    appKeyId: string;
    optionId: string;
    actorJti: string;
    consentedByUserId: string;
  },
  expected: {
    accountId: string;
    creditAccountId: string;
    orgId: string;
    teamId: string;
    serviceId: string;
    appKeyId: string;
    optionId: string;
    actorJti: string;
    userId: string;
  },
): void {
  if (
    revision.accountId !== expected.accountId ||
    revision.creditAccountId !== expected.creditAccountId ||
    revision.orgId !== expected.orgId ||
    revision.teamId !== expected.teamId ||
    revision.serviceId !== expected.serviceId ||
    revision.appKeyId !== expected.appKeyId ||
    revision.optionId !== expected.optionId ||
    revision.actorJti !== expected.actorJti ||
    revision.consentedByUserId !== expected.userId
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_CONSENT_REPLAY_CONFLICT');
  }
}

export async function updateBillingCreditAutoTopUp(
  params: {
    request: CreditFundingActionRequest & { optionId: string };
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: Dependencies,
): Promise<void> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const context = await (deps?.resolveContext ?? resolveCreditFundingActionContext)(params, {
    prisma,
  });
  const state = context.creditAccount.autoTopUpState;
  if (
    !context.creditAccount.stripePaymentMethodId ||
    !context.creditAccount.autoTopUpConsentRevisionId ||
    (state !== BillingCreditAutoTopUpState.ACTIVE && state !== BillingCreditAutoTopUpState.PAUSED)
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_AUTO_TOP_UP_UPDATE_UNAVAILABLE');
  }
  const selection = await (deps?.resolveOption ?? resolveCreditAutoTopUpOption)(
    {
      serviceId: params.credential.service.id,
      accountId: context.account.id,
      optionId: params.request.optionId,
    },
    { prisma },
  );
  await (deps?.validateCatalog ?? assertCreditCatalogPrice)(
    context.stripe,
    context.account,
    selection.catalog,
  );
  const method = await context.stripe.paymentMethods.retrieve(
    context.creditAccount.stripePaymentMethodId,
  );
  assertStripeObjectLivemode(method, context.account.livemode);
  if (
    stripeExternalId(method.customer) !== context.customer.stripeCustomerId ||
    method.type !== 'card' ||
    !method.card
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_PAYMENT_METHOD_UNAVAILABLE');
  }
  const paymentMethodSummary = creditPaymentMethodSummary(method);
  const consentedAt = deps?.now?.() ?? new Date();
  const expected = {
    accountId: context.account.id,
    creditAccountId: context.creditAccount.id,
    orgId: params.request.organisationId,
    teamId: params.request.teamId,
    serviceId: params.credential.service.id,
    appKeyId: params.credential.id,
    optionId: selection.option.id,
    actorJti: context.actor.jti,
    userId: params.request.userId,
  };

  try {
    await prisma.$transaction(
      async (tx) => {
        const locked = await lockConsentSnapshot(tx, context.creditAccount.id);
        if (
          locked.autoTopUpGeneration !== context.creditAccount.autoTopUpGeneration ||
          locked.autoTopUpConsentRevisionId !== context.creditAccount.autoTopUpConsentRevisionId ||
          locked.stripePaymentMethodId !== context.creditAccount.stripePaymentMethodId ||
          (locked.autoTopUpState !== BillingCreditAutoTopUpState.ACTIVE &&
            locked.autoTopUpState !== BillingCreditAutoTopUpState.PAUSED)
        ) {
          throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_CONSENT_PREDECESSOR_CHANGED');
        }
        const replay = await tx.billingCreditAutoTopUpConsentRevision.findUnique({
          where: {
            appKeyId_actorJti: {
              appKeyId: params.credential.id,
              actorJti: context.actor.jti,
            },
          },
        });
        if (replay) {
          assertConsentReplay(replay, expected);
          return;
        }
        const revision = await tx.billingCreditAutoTopUpConsentRevision.create({
          data: {
            accountId: context.account.id,
            creditAccountId: context.creditAccount.id,
            orgId: params.request.organisationId,
            teamId: params.request.teamId,
            serviceId: params.credential.service.id,
            appKeyId: params.credential.id,
            policyId: selection.policy.id,
            optionId: selection.option.id,
            refillOfferId: selection.offer.id,
            source: BillingCreditAutoTopUpConsentSource.CUSTOMER_UPDATE,
            actorJti: context.actor.jti,
            consentedByUserId: params.request.userId,
            consentVersion: selection.policy.automaticConsentVersion,
            thresholdMicrocredits: selection.option.thresholdMicrocredits,
            refillCreditsMicrocredits: selection.offer.creditsReceivedMicrocredits,
            refillPaymentAmountMinor: selection.offer.paymentAmountMinor,
            monthlyChargeCapMinor: selection.option.monthlyChargeCapMinor,
            stripePaymentMethodId: method.id,
            paymentMethodSummary,
            consentedAt,
          },
        });
        const changed = await tx.billingCreditAccount.updateMany({
          where: {
            id: context.creditAccount.id,
            autoTopUpGeneration: locked.autoTopUpGeneration,
            autoTopUpConsentRevisionId: locked.autoTopUpConsentRevisionId,
          },
          data: {
            autoTopUpGeneration: { increment: 1 },
            autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
            autoTopUpPolicyId: selection.policy.id,
            autoTopUpServiceId: params.credential.service.id,
            autoTopUpAppKeyId: params.credential.id,
            autoTopUpConsentRevisionId: revision.id,
            autoTopUpOptionId: selection.option.id,
            autoTopUpThresholdMicrocredits: selection.option.thresholdMicrocredits,
            autoTopUpRefillOfferId: selection.offer.id,
            autoTopUpMonthlyChargeCapMinor: selection.option.monthlyChargeCapMinor,
            autoTopUpConsentVersion: selection.policy.automaticConsentVersion,
            autoTopUpConsentedAt: consentedAt,
            autoTopUpConsentedByUserId: params.request.userId,
            stripePaymentMethodId: method.id,
            paymentMethodSummary,
          },
        });
        if (changed.count !== 1) {
          throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_CONSENT_PREDECESSOR_CHANGED');
        }
        await tx.billingCreditSetupCheckout.updateMany({
          where: {
            creditAccountId: context.creditAccount.id,
            status: {
              in: [
                BillingCreditCheckoutStatus.CREATING,
                BillingCreditCheckoutStatus.OPEN,
                BillingCreditCheckoutStatus.NEEDS_REVIEW,
              ],
            },
          },
          data: { status: BillingCreditCheckoutStatus.ABANDONED },
        });
        await tx.orgAuditLog.create({
          data: {
            orgId: params.request.organisationId,
            actorUserId: params.request.userId,
            action: 'billing.credit_auto_top_up_updated',
            targetType: 'billing_credit_account',
            targetId: context.creditAccount.id,
            metadata: {
              team_id: params.request.teamId,
              service_id: params.credential.service.id,
              app_key_id: params.credential.id,
              option_id: selection.option.id,
              consent_revision_id: revision.id,
              actor_jti: context.actor.jti,
            },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const replay = await prisma.billingCreditAutoTopUpConsentRevision.findUnique({
      where: {
        appKeyId_actorJti: {
          appKeyId: params.credential.id,
          actorJti: context.actor.jti,
        },
      },
    });
    if (!replay) throw error;
    assertConsentReplay(replay, expected);
  }
}

export async function disableBillingCreditAutoTopUp(
  params: {
    request: CreditFundingActionRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: Pick<Dependencies, 'prisma' | 'resolveContext'>,
): Promise<void> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const context = await (deps?.resolveContext ?? resolveCreditFundingActionContext)(params, {
    prisma,
  });
  if (context.creditAccount.autoTopUpState === BillingCreditAutoTopUpState.DISABLED) return;
  await prisma.$transaction(
    async (tx) => {
      const account = await lockConsentSnapshot(tx, context.creditAccount.id);
      if (account.autoTopUpState === BillingCreditAutoTopUpState.DISABLED) return;
      const unresolved = await tx.billingCreditAutoTopUpAttempt.findFirst({
        where: {
          creditAccountId: account.id,
          status: {
            in: [
              BillingCreditAutoTopUpAttemptStatus.PENDING,
              BillingCreditAutoTopUpAttemptStatus.PROCESSING,
              BillingCreditAutoTopUpAttemptStatus.REQUIRES_ACTION,
              BillingCreditAutoTopUpAttemptStatus.NEEDS_REVIEW,
            ],
          },
        },
        select: { id: true },
      });
      if (unresolved) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_AUTO_TOP_UP_PAYMENT_PENDING');
      }
      if (!account.autoTopUpConsentRevisionId) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_CONSENT_PREDECESSOR_MISSING');
      }
      await tx.billingCreditAutoTopUpDisableEvent.create({
        data: {
          accountId: context.account.id,
          creditAccountId: context.creditAccount.id,
          orgId: params.request.organisationId,
          teamId: params.request.teamId,
          serviceId: params.credential.service.id,
          appKeyId: params.credential.id,
          previousConsentRevisionId: account.autoTopUpConsentRevisionId,
          previousGeneration: account.autoTopUpGeneration,
          actorJti: context.actor.jti,
          requestedByUserId: params.request.userId,
        },
      });
      await tx.billingCreditSetupCheckout.updateMany({
        where: {
          creditAccountId: account.id,
          status: {
            in: [
              BillingCreditCheckoutStatus.CREATING,
              BillingCreditCheckoutStatus.OPEN,
              BillingCreditCheckoutStatus.NEEDS_REVIEW,
            ],
          },
        },
        data: { status: BillingCreditCheckoutStatus.ABANDONED },
      });
      await tx.billingCreditAccount.update({
        where: { id: account.id },
        data: {
          autoTopUpGeneration: { increment: 1 },
          autoTopUpState: BillingCreditAutoTopUpState.DISABLED,
          autoTopUpPolicyId: null,
          autoTopUpServiceId: null,
          autoTopUpAppKeyId: null,
          autoTopUpConsentRevisionId: null,
          autoTopUpOptionId: null,
          autoTopUpThresholdMicrocredits: null,
          autoTopUpRefillOfferId: null,
          autoTopUpMonthlyChargeCapMinor: null,
          autoTopUpConsentVersion: null,
          autoTopUpConsentedAt: null,
          autoTopUpConsentedByUserId: null,
          stripePaymentMethodId: null,
          paymentMethodSummary: Prisma.DbNull,
        },
      });
      await tx.orgAuditLog.create({
        data: {
          orgId: params.request.organisationId,
          actorUserId: params.request.userId,
          action: 'billing.credit_auto_top_up_disabled',
          targetType: 'billing_credit_account',
          targetId: account.id,
          metadata: {
            team_id: params.request.teamId,
            service_id: params.credential.service.id,
            app_key_id: params.credential.id,
            actor_jti: context.actor.jti,
            previous_consent_revision_id: account.autoTopUpConsentRevisionId,
          },
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
