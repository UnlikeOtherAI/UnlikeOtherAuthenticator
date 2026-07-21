import { BillingCreditCheckoutStatus, type PrismaClient } from '@prisma/client';
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
  resolveCreditFundingActionContext,
  resolveCreditTopUpOffer,
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

function assertLocalBinding(
  checkout: {
    accountId: string;
    creditAccountId: string;
    customerId: string;
    serviceId: string;
    appKeyId: string;
    offerId: string;
    actorJti: string;
    requestedByUserId: string;
    paymentAmountMinor: bigint;
    creditsReceivedMicrocredits: bigint;
    successUrlDigest: string;
    cancelUrlDigest: string;
  },
  expected: {
    context: CreditFundingActionContext;
    credential: VerifiedBillingAppKey;
    offerId: string;
    actorJti: string;
    userId: string;
    paymentAmountMinor: bigint;
    creditsReceivedMicrocredits: bigint;
    successUrlDigest: string;
    cancelUrlDigest: string;
  },
): void {
  if (
    !sameScopeBinding(checkout, expected) ||
    checkout.actorJti !== expected.actorJti ||
    checkout.requestedByUserId !== expected.userId
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_TOP_UP_REPLAY_CONFLICT');
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
    checkout.offerId === expected.offerId &&
    checkout.paymentAmountMinor === expected.paymentAmountMinor &&
    checkout.creditsReceivedMicrocredits === expected.creditsReceivedMicrocredits &&
    checkout.successUrlDigest === expected.successUrlDigest &&
    checkout.cancelUrlDigest === expected.cancelUrlDigest
  );
}

function openRedirect(session: Stripe.Checkout.Session): { redirect_url: string } {
  if (session.status !== 'open' || !session.url || !session.url.startsWith('https://')) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_TOP_UP_NOT_OPEN');
  }
  return { redirect_url: session.url };
}

type Dependencies = {
  prisma?: PrismaClient;
  now?: () => Date;
  resolveContext?: typeof resolveCreditFundingActionContext;
  resolveOffer?: typeof resolveCreditTopUpOffer;
  validateCatalog?: typeof assertCreditCatalogPrice;
  afterStripeSessionCreated?: () => void | Promise<void>;
};

export async function createBillingCreditTopUpCheckout(
  params: {
    request: CreditFundingActionRequest & { offerId: string };
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: Dependencies,
): Promise<{ redirect_url: string }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const context = await (deps?.resolveContext ?? resolveCreditFundingActionContext)(params, {
    prisma,
  });
  const selection = await (deps?.resolveOffer ?? resolveCreditTopUpOffer)(
    {
      serviceId: params.credential.service.id,
      accountId: context.account.id,
      offerId: params.request.offerId,
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
    offerId: selection.offer.id,
    actorJti: context.actor.jti,
    userId: params.request.userId,
    paymentAmountMinor: selection.offer.paymentAmountMinor,
    creditsReceivedMicrocredits: selection.offer.creditsReceivedMicrocredits,
    successUrlDigest,
    cancelUrlDigest,
  };

  const replay = await prisma.billingCreditTopUpCheckout.findUnique({
    where: {
      appKeyId_actorJti_offerId: {
        appKeyId: params.credential.id,
        actorJti: context.actor.jti,
        offerId: selection.offer.id,
      },
    },
  });
  if (replay) {
    assertLocalBinding(replay, expected);
    const recovered = await reconcileCreditCheckout(
      {
        checkout: replay,
        kind: 'top_up',
        customerStripeId: context.customer.stripeCustomerId as string,
        account: context.account,
        now,
      },
      { prisma, stripe: context.stripe },
    );
    if (recovered.session) return openRedirect(recovered.session);
    throw new AppError('INTERNAL', 503, 'BILLING_CREDIT_TOP_UP_RETRY');
  }

  const unresolved = await prisma.billingCreditTopUpCheckout.findFirst({
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
        kind: 'top_up',
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
      throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_TOP_UP_PENDING');
    }
  }

  let checkout;
  try {
    checkout = await prisma.billingCreditTopUpCheckout.create({
      data: {
        accountId: context.account.id,
        creditAccountId: context.creditAccount.id,
        customerId: context.customer.id,
        catalogId: selection.catalog.id,
        serviceId: params.credential.service.id,
        appKeyId: params.credential.id,
        offerId: selection.offer.id,
        actorJti: context.actor.jti,
        requestedByUserId: params.request.userId,
        paymentAmountMinor: selection.offer.paymentAmountMinor,
        creditsReceivedMicrocredits: selection.offer.creditsReceivedMicrocredits,
        currency: 'USD',
        successUrlDigest,
        cancelUrlDigest,
        leaseExpiresAt: new Date(now.getTime() + CHECKOUT_LEASE_MS),
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const winner = await prisma.billingCreditTopUpCheckout.findFirst({
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
          kind: 'top_up',
          customerStripeId: context.customer.stripeCustomerId as string,
          account: context.account,
          now,
        },
        { prisma, stripe: context.stripe },
      );
      if (recovered.session?.status === 'open') return openRedirect(recovered.session);
    }
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_TOP_UP_PENDING');
  }

  const metadata = creditFundingMetadata({
    localType: 'top_up',
    localId: checkout.id,
    serviceId: checkout.serviceId,
    appKeyId: checkout.appKeyId,
    creditAccountId: checkout.creditAccountId,
  });
  const session = await context.stripe.checkout.sessions.create(
    {
      mode: 'payment',
      customer: context.customer.stripeCustomerId as string,
      client_reference_id: checkout.id,
      success_url: returns.checkoutSuccess,
      cancel_url: returns.checkoutCancel,
      allow_promotion_codes: false,
      billing_address_collection: 'required',
      line_items: [{ price: selection.catalog.stripePriceId as string, quantity: 1 }],
      metadata,
      payment_intent_data: { metadata },
    },
    {
      idempotencyKey: creditCheckoutIdempotencyKey(context.account, 'top_up', checkout.id),
    },
  );
  assertStripeObjectLivemode(session, context.account.livemode);
  assertCreditFundingMetadata(session.metadata, {
    localType: 'top_up',
    localId: checkout.id,
    serviceId: checkout.serviceId,
    appKeyId: checkout.appKeyId,
    creditAccountId: checkout.creditAccountId,
  });
  if (
    session.mode !== 'payment' ||
    session.client_reference_id !== checkout.id ||
    stripeExternalId(session.customer) !== context.customer.stripeCustomerId ||
    !session.url
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_CHECKOUT_BINDING_INVALID');
  }
  await deps?.afterStripeSessionCreated?.();
  await prisma.billingCreditTopUpCheckout.update({
    where: { id: checkout.id },
    data: {
      stripeCheckoutSessionId: session.id,
      status: BillingCreditCheckoutStatus.OPEN,
      expiresAt: new Date(session.expires_at * 1000),
    },
  });
  return openRedirect(session);
}
