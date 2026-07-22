import {
  BillingCreditAutoTopUpAttemptStatus,
  BillingCreditAutoTopUpState,
  type PrismaClient,
} from '@prisma/client';
import type Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { BILLING_CUSTOMER_ACTION } from './billing-customer-action-intent.service.js';
import { assertCreditFundingMetadata } from './billing-credit-funding-binding.service.js';
import { exactMinor, requireUsd } from './billing-credit-funding-webhook-validation.service.js';
import {
  resolveCreditFundingActionContext,
  type CreditFundingActionContext,
  type CreditFundingActionRequest,
} from './billing-credit-funding-context.service.js';
import { createBillingCreditAutoTopUpSetup } from './billing-credit-auto-top-up-setup.service.js';
import { assertStripeObjectLivemode } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

type Dependencies = {
  prisma?: PrismaClient;
  resolveContext?: typeof resolveCreditFundingActionContext;
  createSetup?: typeof createBillingCreditAutoTopUpSetup;
};

function safeRedirectUrl(intent: Stripe.PaymentIntent): string | null {
  const value = intent.next_action?.redirect_to_url?.url;
  if (intent.next_action?.type !== 'redirect_to_url' || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

type RecoveryAttempt = {
  id: string;
  creditAccountId: string;
  serviceId: string;
  appKeyId: string;
  stripePaymentIntentId: string | null;
  paymentAmountMinor: bigint;
  failureCode: string | null;
  status: BillingCreditAutoTopUpAttemptStatus;
  stateWebhookEventId: string | null;
  consentRevision: { stripePaymentMethodId: string };
};

function assertRecoveryIntent(
  intent: Stripe.PaymentIntent,
  attempt: RecoveryAttempt,
  context: CreditFundingActionContext,
  errorCode: string,
): void {
  assertStripeObjectLivemode(intent, context.account.livemode);
  assertCreditFundingMetadata(
    intent.metadata,
    {
      localType: 'automatic_top_up',
      localId: attempt.id,
      serviceId: attempt.serviceId,
      appKeyId: attempt.appKeyId,
      creditAccountId: attempt.creditAccountId,
    },
    errorCode,
  );
  if (
    stripeExternalId(intent.customer) !== context.customer.stripeCustomerId ||
    stripeExternalId(intent.payment_method) !== attempt.consentRevision.stripePaymentMethodId ||
    exactMinor(intent.amount) !== attempt.paymentAmountMinor ||
    requireUsd(intent.currency) !== 'USD'
  ) {
    throw new AppError('INTERNAL', 502, errorCode);
  }
}

async function terminalizeCurrentAttempt(
  intent: Stripe.PaymentIntent,
  attempt: RecoveryAttempt,
  prisma: PrismaClient,
  status: BillingCreditAutoTopUpAttemptStatus,
  failureCode: string,
): Promise<void> {
  const terminalized = await prisma.billingCreditAutoTopUpAttempt.updateMany({
    where: {
      id: attempt.id,
      stripePaymentIntentId: intent.id,
      status: attempt.status,
      stateWebhookEventId: attempt.stateWebhookEventId,
    },
    data: { status, failureCode, resolvedAt: new Date() },
  });
  if (terminalized.count !== 1) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_AUTO_TOP_UP_RECOVERY_PENDING');
  }
}

async function cancelAndTerminalize(
  intent: Stripe.PaymentIntent,
  attempt: RecoveryAttempt,
  context: CreditFundingActionContext,
  prisma: PrismaClient,
  status: BillingCreditAutoTopUpAttemptStatus,
  failureCode: string,
): Promise<void> {
  const canceled = await context.stripe.paymentIntents.cancel(
    intent.id,
    {},
    { idempotencyKey: `uoa:auto-top-up-recovery-cancel:${attempt.id}` },
  );
  assertRecoveryIntent(canceled, attempt, context, 'STRIPE_CREDIT_AUTO_TOP_UP_CANCEL_INVALID');
  if (canceled.status !== 'canceled') {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_AUTO_TOP_UP_CANCEL_INVALID');
  }
  await terminalizeCurrentAttempt(intent, attempt, prisma, status, failureCode);
}

export async function recoverBillingCreditAutoTopUp(
  params: {
    request: CreditFundingActionRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: Dependencies,
): Promise<{ redirect_url: string }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const context = await (deps?.resolveContext ?? resolveCreditFundingActionContext)(
    {
      ...params,
      action: {
        operation: BILLING_CUSTOMER_ACTION.CREDIT_AUTO_TOP_UP_RECOVER,
        request: {
          product: params.request.product,
          organisation_id: params.request.organisationId,
          team_id: params.request.teamId,
          user_id: params.request.userId,
        },
      },
    },
    { prisma },
  );
  const state = context.creditAccount.autoTopUpState;
  if (
    state !== BillingCreditAutoTopUpState.REQUIRES_ACTION &&
    state !== BillingCreditAutoTopUpState.NEEDS_REVIEW &&
    state !== BillingCreditAutoTopUpState.PAUSED
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_AUTO_TOP_UP_RECOVERY_UNAVAILABLE');
  }
  let actionAuthorized = false;
  const authorizeMutation = async (): Promise<void> => {
    if (actionAuthorized) return;
    await context.authorizeAction();
    actionAuthorized = true;
  };
  const unresolved = await prisma.billingCreditAutoTopUpAttempt.findFirst({
    where: {
      creditAccountId: context.creditAccount.id,
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
    include: { consentRevision: true, stateWebhookEvent: { select: { type: true } } },
  });
  if (unresolved) {
    if (!unresolved.stripePaymentIntentId) {
      throw new AppError('INTERNAL', 503, 'BILLING_CREDIT_AUTO_TOP_UP_PAYMENT_PENDING');
    }
    const intent = await context.stripe.paymentIntents.retrieve(unresolved.stripePaymentIntentId);
    assertRecoveryIntent(intent, unresolved, context, 'STRIPE_CREDIT_AUTO_TOP_UP_BINDING_INVALID');
    const redirectUrl = safeRedirectUrl(intent);
    if (intent.status === 'requires_action' && redirectUrl) {
      return { redirect_url: redirectUrl };
    }
    if (intent.status === 'canceled') {
      await authorizeMutation();
      await terminalizeCurrentAttempt(
        intent,
        unresolved,
        prisma,
        BillingCreditAutoTopUpAttemptStatus.CANCELED,
        unresolved.failureCode ?? 'payment_intent_canceled',
      );
    } else if (
      ['requires_payment_method', 'requires_confirmation'].includes(intent.status) &&
      unresolved.status === BillingCreditAutoTopUpAttemptStatus.NEEDS_REVIEW &&
      unresolved.stateWebhookEvent?.type === 'payment_intent.payment_failed'
    ) {
      await authorizeMutation();
      await cancelAndTerminalize(
        intent,
        unresolved,
        context,
        prisma,
        BillingCreditAutoTopUpAttemptStatus.FAILED,
        unresolved.failureCode ?? 'payment_method_replacement_required',
      );
    } else if (
      intent.status === 'requires_action' &&
      unresolved.status === BillingCreditAutoTopUpAttemptStatus.REQUIRES_ACTION
    ) {
      await authorizeMutation();
      await cancelAndTerminalize(
        intent,
        unresolved,
        context,
        prisma,
        BillingCreditAutoTopUpAttemptStatus.CANCELED,
        'unsafe_recovery_redirect',
      );
    } else {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_AUTO_TOP_UP_RECOVERY_PENDING');
    }
  }
  if (!context.creditAccount.autoTopUpOptionId) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_AUTO_TOP_UP_RECOVERY_UNAVAILABLE');
  }
  return (deps?.createSetup ?? createBillingCreditAutoTopUpSetup)(
    {
      request: {
        ...params.request,
        optionId: context.creditAccount.autoTopUpOptionId,
      },
      actorToken: params.actorToken,
      credential: params.credential,
      recovery: true,
    },
    { prisma },
  );
}
