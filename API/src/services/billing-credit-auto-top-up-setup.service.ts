import {
  BillingCreditAutoTopUpState,
  BillingCreditCheckoutStatus,
  type PrismaClient,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import type Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  creditCheckoutIdempotencyKey,
  reconcileCreditCheckout,
} from './billing-credit-checkout-recovery.service.js';
import {
  assertCreditCatalogPrice,
  resolveCreditAutoTopUpOption,
  resolveCreditFundingActionContext,
  type CreditFundingActionContext,
  type CreditFundingActionRequest,
} from './billing-credit-funding-context.service.js';
import {
  assertCreditFundingMetadata,
  creditFundingMetadata,
} from './billing-credit-funding-binding.service.js';
import { pinnedBillingReturnUrls } from './billing-return-url-policy.service.js';
import { assertStripeObjectLivemode } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

const CHECKOUT_LEASE_MS = 10 * 60 * 1000;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2002';
}

function openRedirect(session: Stripe.Checkout.Session): { redirect_url: string } {
  if (session.status !== 'open' || !session.url || !session.url.startsWith('https://')) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_SETUP_NOT_OPEN');
  }
  return { redirect_url: session.url };
}

function assertLocalBinding(
  checkout: {
    accountId: string;
    creditAccountId: string;
    customerId: string;
    serviceId: string;
    appKeyId: string;
    policyId: string;
    optionId: string;
    actorJti: string;
    requestedByUserId: string;
    expectedGeneration: number;
    expectedConsentRevisionId: string | null;
    consentVersion: string;
    thresholdMicrocredits: bigint;
    refillOfferId: string;
    refillCreditsMicrocredits: bigint;
    refillPaymentAmountMinor: bigint;
    monthlyChargeCapMinor: bigint;
    successUrlDigest: string;
    cancelUrlDigest: string;
  },
  expected: {
    context: CreditFundingActionContext;
    credential: VerifiedBillingAppKey;
    policyId: string;
    optionId: string;
    actorJti: string;
    userId: string;
    expectedGeneration: number;
    expectedConsentRevisionId: string | null;
    consentVersion: string;
    thresholdMicrocredits: bigint;
    refillOfferId: string;
    refillCreditsMicrocredits: bigint;
    refillPaymentAmountMinor: bigint;
    monthlyChargeCapMinor: bigint;
    successUrlDigest: string;
    cancelUrlDigest: string;
  },
): void {
  if (
    !sameScopeBinding(checkout, expected) ||
    checkout.actorJti !== expected.actorJti ||
    checkout.requestedByUserId !== expected.userId
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_SETUP_REPLAY_CONFLICT');
  }
}

function sameScopeBinding(
  checkout: Parameters<typeof assertLocalBinding>[0],
  expected: Parameters<typeof assertLocalBinding>[1],
): boolean {
  return (
    checkout.accountId === expected.context.account.id &&
    checkout.creditAccountId === expected.context.creditAccount.id &&
    checkout.customerId === expected.context.customer.id &&
    checkout.serviceId === expected.credential.service.id &&
    checkout.appKeyId === expected.credential.id &&
    checkout.policyId === expected.policyId &&
    checkout.optionId === expected.optionId &&
    checkout.expectedGeneration === expected.expectedGeneration &&
    checkout.expectedConsentRevisionId === expected.expectedConsentRevisionId &&
    checkout.consentVersion === expected.consentVersion &&
    checkout.thresholdMicrocredits === expected.thresholdMicrocredits &&
    checkout.refillOfferId === expected.refillOfferId &&
    checkout.refillCreditsMicrocredits === expected.refillCreditsMicrocredits &&
    checkout.refillPaymentAmountMinor === expected.refillPaymentAmountMinor &&
    checkout.monthlyChargeCapMinor === expected.monthlyChargeCapMinor &&
    checkout.successUrlDigest === expected.successUrlDigest &&
    checkout.cancelUrlDigest === expected.cancelUrlDigest
  );
}

type Dependencies = {
  prisma?: PrismaClient;
  now?: () => Date;
  resolveContext?: typeof resolveCreditFundingActionContext;
  resolveOption?: typeof resolveCreditAutoTopUpOption;
  validateCatalog?: typeof assertCreditCatalogPrice;
  afterStripeSessionCreated?: () => void | Promise<void>;
};

export async function createBillingCreditAutoTopUpSetup(
  params: {
    request: CreditFundingActionRequest & { optionId: string };
    actorToken: string;
    credential: VerifiedBillingAppKey;
    recovery?: boolean;
  },
  deps?: Dependencies,
): Promise<{ redirect_url: string }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const context = await (deps?.resolveContext ?? resolveCreditFundingActionContext)(params, {
    prisma,
  });
  const state = context.creditAccount.autoTopUpState;
  const recoveryState =
    state === BillingCreditAutoTopUpState.REQUIRES_ACTION ||
    state === BillingCreditAutoTopUpState.NEEDS_REVIEW ||
    state === BillingCreditAutoTopUpState.PAUSED;
  if (
    params.recovery
      ? !recoveryState
      : state !== BillingCreditAutoTopUpState.DISABLED ||
        Boolean(context.creditAccount.stripePaymentMethodId)
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_SETUP_STATE_INVALID');
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
  const returns = pinnedBillingReturnUrls(params.credential.checkoutReturnOrigins);
  const successUrlDigest = digest(returns.checkoutSuccess);
  const cancelUrlDigest = digest(returns.checkoutCancel);
  const now = deps?.now?.() ?? new Date();
  const expected = {
    context,
    credential: params.credential,
    policyId: selection.policy.id,
    optionId: selection.option.id,
    actorJti: context.actor.jti,
    userId: params.request.userId,
    expectedGeneration: context.creditAccount.autoTopUpGeneration,
    expectedConsentRevisionId: context.creditAccount.autoTopUpConsentRevisionId,
    consentVersion: selection.policy.automaticConsentVersion,
    thresholdMicrocredits: selection.option.thresholdMicrocredits,
    refillOfferId: selection.offer.id,
    refillCreditsMicrocredits: selection.offer.creditsReceivedMicrocredits,
    refillPaymentAmountMinor: selection.offer.paymentAmountMinor,
    monthlyChargeCapMinor: selection.option.monthlyChargeCapMinor,
    successUrlDigest,
    cancelUrlDigest,
  };

  const replay = await prisma.billingCreditSetupCheckout.findUnique({
    where: {
      appKeyId_actorJti_optionId: {
        appKeyId: params.credential.id,
        actorJti: context.actor.jti,
        optionId: selection.option.id,
      },
    },
  });
  if (replay) {
    assertLocalBinding(replay, expected);
    const recovered = await reconcileCreditCheckout(
      {
        checkout: replay,
        kind: 'setup',
        customerStripeId: context.customer.stripeCustomerId as string,
        account: context.account,
        now,
      },
      { prisma, stripe: context.stripe },
    );
    if (recovered.session) return openRedirect(recovered.session);
    throw new AppError('INTERNAL', 503, 'BILLING_CREDIT_SETUP_RETRY');
  }

  const unresolved = await prisma.billingCreditSetupCheckout.findFirst({
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
  });
  if (unresolved) {
    const recovered = await reconcileCreditCheckout(
      {
        checkout: unresolved,
        kind: 'setup',
        customerStripeId: context.customer.stripeCustomerId as string,
        account: context.account,
        now,
      },
      { prisma, stripe: context.stripe },
    );
    if (sameScopeBinding(unresolved, expected) && recovered.session?.status === 'open') {
      return openRedirect(recovered.session);
    }
    if (!recovered.abandoned && recovered.session?.status !== 'expired') {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_SETUP_PENDING');
    }
  }

  let checkout;
  try {
    checkout = await prisma.billingCreditSetupCheckout.create({
      data: {
        accountId: context.account.id,
        creditAccountId: context.creditAccount.id,
        customerId: context.customer.id,
        serviceId: params.credential.service.id,
        appKeyId: params.credential.id,
        policyId: selection.policy.id,
        optionId: selection.option.id,
        actorJti: context.actor.jti,
        requestedByUserId: params.request.userId,
        expectedGeneration: context.creditAccount.autoTopUpGeneration,
        expectedConsentRevisionId: context.creditAccount.autoTopUpConsentRevisionId,
        consentVersion: selection.policy.automaticConsentVersion,
        thresholdMicrocredits: selection.option.thresholdMicrocredits,
        refillOfferId: selection.offer.id,
        refillCreditsMicrocredits: selection.offer.creditsReceivedMicrocredits,
        refillPaymentAmountMinor: selection.offer.paymentAmountMinor,
        monthlyChargeCapMinor: selection.option.monthlyChargeCapMinor,
        successUrlDigest,
        cancelUrlDigest,
        leaseExpiresAt: new Date(now.getTime() + CHECKOUT_LEASE_MS),
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const winner = await prisma.billingCreditSetupCheckout.findFirst({
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
    });
    if (winner && sameScopeBinding(winner, expected)) {
      const recovered = await reconcileCreditCheckout(
        {
          checkout: winner,
          kind: 'setup',
          customerStripeId: context.customer.stripeCustomerId as string,
          account: context.account,
          now,
        },
        { prisma, stripe: context.stripe },
      );
      if (recovered.session?.status === 'open') return openRedirect(recovered.session);
    }
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_SETUP_PENDING');
  }

  const metadata = creditFundingMetadata({
    localType: 'setup',
    localId: checkout.id,
    serviceId: checkout.serviceId,
    appKeyId: checkout.appKeyId,
    creditAccountId: checkout.creditAccountId,
  });
  const session = await context.stripe.checkout.sessions.create(
    {
      mode: 'setup',
      customer: context.customer.stripeCustomerId as string,
      client_reference_id: checkout.id,
      success_url: returns.checkoutSuccess,
      cancel_url: returns.checkoutCancel,
      payment_method_types: ['card'],
      metadata,
      setup_intent_data: { metadata },
    },
    {
      idempotencyKey: creditCheckoutIdempotencyKey(context.account, 'setup', checkout.id),
    },
  );
  assertStripeObjectLivemode(session, context.account.livemode);
  assertCreditFundingMetadata(session.metadata, {
    localType: 'setup',
    localId: checkout.id,
    serviceId: checkout.serviceId,
    appKeyId: checkout.appKeyId,
    creditAccountId: checkout.creditAccountId,
  });
  if (
    session.mode !== 'setup' ||
    session.client_reference_id !== checkout.id ||
    stripeExternalId(session.customer) !== context.customer.stripeCustomerId ||
    !session.url
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_CHECKOUT_BINDING_INVALID');
  }
  await deps?.afterStripeSessionCreated?.();
  const opened = await prisma.billingCreditSetupCheckout.updateMany({
    where: {
      id: checkout.id,
      status: BillingCreditCheckoutStatus.CREATING,
      expectedGeneration: checkout.expectedGeneration,
      expectedConsentRevisionId: checkout.expectedConsentRevisionId,
    },
    data: {
      stripeCheckoutSessionId: session.id,
      status: BillingCreditCheckoutStatus.OPEN,
      expiresAt: new Date(session.expires_at * 1000),
    },
  });
  if (opened.count !== 1) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_SETUP_PREDECESSOR_CHANGED');
  }
  return openRedirect(session);
}
