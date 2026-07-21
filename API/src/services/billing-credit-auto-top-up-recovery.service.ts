import {
  BillingCreditAutoTopUpAttemptStatus,
  BillingCreditAutoTopUpState,
  type PrismaClient,
} from '@prisma/client';
import type Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { paymentBinding } from './billing-credit-funding-binding.service.js';
import {
  resolveCreditFundingActionContext,
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

export async function recoverBillingCreditAutoTopUp(
  params: {
    request: CreditFundingActionRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: Dependencies,
): Promise<{ redirect_url: string }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const context = await (deps?.resolveContext ?? resolveCreditFundingActionContext)(params, {
    prisma,
  });
  const state = context.creditAccount.autoTopUpState;
  if (
    state !== BillingCreditAutoTopUpState.REQUIRES_ACTION &&
    state !== BillingCreditAutoTopUpState.NEEDS_REVIEW &&
    state !== BillingCreditAutoTopUpState.PAUSED
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_AUTO_TOP_UP_RECOVERY_UNAVAILABLE');
  }
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
    include: { consentRevision: true },
  });
  if (unresolved) {
    if (!unresolved.stripePaymentIntentId) {
      throw new AppError('INTERNAL', 503, 'BILLING_CREDIT_AUTO_TOP_UP_PAYMENT_PENDING');
    }
    const intent = await context.stripe.paymentIntents.retrieve(unresolved.stripePaymentIntentId);
    assertStripeObjectLivemode(intent, context.account.livemode);
    const binding = paymentBinding(intent.metadata);
    if (
      binding?.localType !== 'automatic_top_up' ||
      binding.localId !== unresolved.id ||
      stripeExternalId(intent.customer) !== context.customer.stripeCustomerId ||
      stripeExternalId(intent.payment_method) !==
        unresolved.consentRevision.stripePaymentMethodId ||
      intent.amount !== Number(unresolved.paymentAmountMinor) ||
      intent.currency.toUpperCase() !== 'USD'
    ) {
      throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_AUTO_TOP_UP_BINDING_INVALID');
    }
    const redirectUrl = safeRedirectUrl(intent);
    if (intent.status === 'requires_action' && redirectUrl) {
      return { redirect_url: redirectUrl };
    }
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_AUTO_TOP_UP_RECOVERY_PENDING');
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
