import { type Prisma, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import {
  assertStripeObjectLivemode,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';
import { preparePaymentAdjustmentWebhook } from './billing-credit-payment-adjustment-prepare.service.js';
import {
  paymentBinding,
  setupBinding,
} from './billing-credit-funding-binding.service.js';
import type {
  CreditFundingWebhookClient,
  CreditPaymentBinding,
  PreparedCreditFundingWebhook,
} from './billing-credit-funding-webhook.types.js';
import {
  exactMinor,
  requireUsd,
} from './billing-credit-funding-webhook-validation.service.js';

function methodSummary(method: Stripe.PaymentMethod): Prisma.InputJsonValue {
  if (!method.card) return { type: method.type };
  return {
    type: 'card',
    brand: method.card.brand,
    last4: method.card.last4,
    exp_month: method.card.exp_month,
    exp_year: method.card.exp_year,
  };
}

async function retrieveBoundSession(
  stripe: CreditFundingWebhookClient,
  params: {
    sessionId: string;
    account: StripeAccountContext;
    customerId: string;
    mode: 'payment' | 'setup';
    localKey: 'uoa_credit_setup_checkout_id' | 'uoa_credit_top_up_checkout_id';
    localId: string;
    intentId: string;
  },
): Promise<Stripe.Checkout.Session> {
  const session = await stripe.checkout.sessions.retrieve(params.sessionId);
  assertStripeObjectLivemode(session, params.account.livemode);
  const linkedIntent =
    params.mode === 'payment'
      ? stripeExternalId(session.payment_intent)
      : stripeExternalId(session.setup_intent);
  if (
    session.mode !== params.mode ||
    stripeExternalId(session.customer) !== params.customerId ||
    linkedIntent !== params.intentId ||
    session.metadata?.[params.localKey]?.trim() !== params.localId
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_CHECKOUT_BINDING_INVALID');
  }
  return session;
}

async function validatePaymentBinding(
  binding: CreditPaymentBinding,
  intent: Stripe.PaymentIntent,
  stripe: CreditFundingWebhookClient,
  account: StripeAccountContext,
  prisma: PrismaClient,
): Promise<string | null> {
  const customerId = stripeExternalId(intent.customer);
  const paymentMethodId = stripeExternalId(intent.payment_method);
  if (!customerId) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_PAYMENT_BINDING_INVALID');
  }
  if (binding.localType === 'top_up') {
    const checkout = await prisma.billingCreditTopUpCheckout.findUnique({
      where: { id: binding.localId },
      include: { customer: true },
    });
    if (
      !checkout ||
      checkout.accountId !== account.id ||
      !checkout.stripeCheckoutSessionId ||
      checkout.customer.stripeCustomerId !== customerId ||
      checkout.paymentAmountMinor !== exactMinor(intent.amount) ||
      checkout.currency !== requireUsd(intent.currency)
    ) {
      throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_TOP_UP_BINDING_INVALID');
    }
    const session = await retrieveBoundSession(stripe, {
      sessionId: checkout.stripeCheckoutSessionId,
      account,
      customerId,
      mode: 'payment',
      localKey: 'uoa_credit_top_up_checkout_id',
      localId: checkout.id,
      intentId: intent.id,
    });
    return session.id;
  }

  const attempt = await prisma.billingCreditAutoTopUpAttempt.findUnique({
    where: { id: binding.localId },
    include: {
      consentRevision: true,
      creditAccount: { include: { customer: true } },
    },
  });
  if (
    !attempt ||
    attempt.accountId !== account.id ||
    attempt.creditAccount.customer.stripeCustomerId !== customerId ||
    attempt.paymentAmountMinor !== exactMinor(intent.amount) ||
    (attempt.stripePaymentIntentId && attempt.stripePaymentIntentId !== intent.id) ||
    paymentMethodId !== attempt.consentRevision.stripePaymentMethodId ||
    requireUsd(intent.currency) !== 'USD'
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_AUTO_TOP_UP_BINDING_INVALID');
  }
  return null;
}

async function preparePaymentIntent(
  event: Stripe.Event,
  stripe: CreditFundingWebhookClient,
  account: StripeAccountContext,
  prisma: PrismaClient,
): Promise<PreparedCreditFundingWebhook | null> {
  const supportedTypes = new Set([
    'payment_intent.succeeded',
    'payment_intent.payment_failed',
    'payment_intent.processing',
    'payment_intent.requires_action',
    'payment_intent.canceled',
  ]);
  if (!supportedTypes.has(event.type)) {
    return null;
  }
  const payload = event.data.object as Stripe.PaymentIntent;
  const intent = await stripe.paymentIntents.retrieve(payload.id);
  assertStripeObjectLivemode(intent, account.livemode);
  const binding = paymentBinding(intent.metadata);
  if (!binding) return null;
  const payloadBinding = paymentBinding(payload.metadata);
  if (!payloadBinding) return null;
  if (
    payloadBinding.localId !== binding.localId ||
    payloadBinding.localType !== binding.localType ||
    payload.status !== intent.status ||
    payload.amount !== intent.amount ||
    payload.currency !== intent.currency ||
    stripeExternalId(payload.customer) !== stripeExternalId(intent.customer) ||
    stripeExternalId(payload.payment_method) !== stripeExternalId(intent.payment_method) ||
    stripeExternalId(payload.latest_charge) !== stripeExternalId(intent.latest_charge) ||
    payload.last_payment_error?.code !== intent.last_payment_error?.code ||
    payload.cancellation_reason !== intent.cancellation_reason
  ) {
    return null;
  }
  const succeeded = event.type === 'payment_intent.succeeded';
  const failed = event.type === 'payment_intent.payment_failed';
  if (succeeded && intent.status !== 'succeeded') {
    throw new AppError('INTERNAL', 503, 'STRIPE_CREDIT_PAYMENT_NOT_SETTLED');
  }
  if (!succeeded && intent.status === 'succeeded') return null;
  const state =
    event.type === 'payment_intent.processing' && intent.status === 'processing'
      ? ('processing' as const)
      : event.type === 'payment_intent.requires_action' && intent.status === 'requires_action'
        ? ('requires_action' as const)
        : event.type === 'payment_intent.canceled' && intent.status === 'canceled'
          ? ('canceled' as const)
          : null;
  if (!succeeded && !failed && !state) return null;
  const checkoutSessionId = await validatePaymentBinding(
    binding,
    intent,
    stripe,
    account,
    prisma,
  );
  const paymentMethodId = stripeExternalId(intent.payment_method);
  const chargeId = stripeExternalId(intent.latest_charge);
  if (succeeded && (!paymentMethodId || !chargeId || intent.amount_received !== intent.amount)) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_PAYMENT_PROOF_INVALID');
  }
  const occurredAt = new Date(event.created * 1000);
  if (state && binding.localType === 'top_up') return null;
  return {
    event: state
      ? {
          kind: 'payment_state_changed',
          ...binding,
          paymentIntent: intent,
          paymentMethodId,
          state,
          occurredAt,
        }
      : succeeded
        ? {
          kind: 'payment_succeeded',
          ...binding,
          paymentIntent: intent,
          paymentMethodId: paymentMethodId as string,
          chargeId: chargeId as string,
          checkoutSessionId,
          occurredAt,
          }
        : {
          kind: 'payment_failed',
          ...binding,
          paymentIntent: intent,
          paymentMethodId,
          chargeId,
          checkoutSessionId,
          occurredAt,
          },
    eventFields: {
      stripeObjectId: intent.id,
      stripeObjectStatus: intent.status,
      stripeCustomerId: stripeExternalId(intent.customer),
      stripeCheckoutSessionId: checkoutSessionId,
      stripePaymentIntentId: intent.id,
      stripeChargeId: chargeId,
      stripePaymentMethodId: paymentMethodId,
      amountMinor: exactMinor(succeeded ? intent.amount_received : intent.amount),
      currency: requireUsd(intent.currency),
      stripeCreatedAt: occurredAt,
    },
  };
}

async function prepareSetupIntent(
  event: Stripe.Event,
  stripe: CreditFundingWebhookClient,
  account: StripeAccountContext,
  prisma: PrismaClient,
): Promise<PreparedCreditFundingWebhook | null> {
  if (event.type !== 'setup_intent.succeeded') return null;
  const payload = event.data.object as Stripe.SetupIntent;
  const intent = await stripe.setupIntents.retrieve(payload.id);
  assertStripeObjectLivemode(intent, account.livemode);
  const localId = setupBinding(intent.metadata);
  if (!localId) return null;
  const checkout = await prisma.billingCreditSetupCheckout.findUnique({
    where: { id: localId },
    include: { customer: true },
  });
  const customerId = stripeExternalId(intent.customer);
  const paymentMethodId = stripeExternalId(intent.payment_method);
  if (
    intent.status !== 'succeeded' ||
    intent.usage !== 'off_session' ||
    !checkout ||
    checkout.accountId !== account.id ||
    !checkout.stripeCheckoutSessionId ||
    !customerId ||
    checkout.customer.stripeCustomerId !== customerId ||
    !paymentMethodId
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_SETUP_BINDING_INVALID');
  }
  const session = await retrieveBoundSession(stripe, {
    sessionId: checkout.stripeCheckoutSessionId,
    account,
    customerId,
    mode: 'setup',
    localKey: 'uoa_credit_setup_checkout_id',
    localId,
    intentId: intent.id,
  });
  const method = await stripe.paymentMethods.retrieve(paymentMethodId);
  assertStripeObjectLivemode(method, account.livemode);
  if (stripeExternalId(method.customer) !== customerId) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_PAYMENT_METHOD_INVALID');
  }
  const occurredAt = new Date(event.created * 1000);
  return {
    event: {
      kind: 'setup_succeeded',
      localId,
      setupIntent: intent,
      checkoutSessionId: session.id,
      paymentMethodId,
      paymentMethodSummary: methodSummary(method),
      occurredAt,
    },
    eventFields: {
      stripeObjectId: intent.id,
      stripeObjectStatus: intent.status,
      stripeCustomerId: customerId,
      stripeCheckoutSessionId: session.id,
      stripeSetupIntentId: intent.id,
      stripePaymentMethodId: paymentMethodId,
      stripeCreatedAt: occurredAt,
    },
  };
}

async function prepareExpiredCheckout(
  event: Stripe.Event,
  stripe: CreditFundingWebhookClient,
  account: StripeAccountContext,
  prisma: PrismaClient,
): Promise<PreparedCreditFundingWebhook | null> {
  if (event.type !== 'checkout.session.expired') return null;
  const payload = event.data.object as Stripe.Checkout.Session;
  const session = await stripe.checkout.sessions.retrieve(payload.id);
  assertStripeObjectLivemode(session, account.livemode);
  const topUpId = paymentBinding(session.metadata);
  const setupId = setupBinding(session.metadata);
  if (!topUpId && !setupId) return null;
  if (topUpId?.localType === 'automatic_top_up' || (topUpId && setupId)) {
    throw new AppError('BAD_REQUEST', 400, 'STRIPE_CREDIT_METADATA_INVALID');
  }
  const localId = topUpId?.localId ?? (setupId as string);
  const localType = topUpId ? 'top_up' : 'setup';
  const expectedMode = topUpId ? 'payment' : 'setup';
  if (session.mode !== expectedMode) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_CHECKOUT_BINDING_INVALID');
  }
  if (session.status === 'complete') return null;
  if (session.status !== 'expired') {
    throw new AppError('INTERNAL', 503, 'STRIPE_CREDIT_CHECKOUT_EXPIRY_PENDING');
  }
  const checkout = topUpId
    ? await prisma.billingCreditTopUpCheckout.findUnique({
        where: { id: localId },
        include: { customer: true },
      })
    : await prisma.billingCreditSetupCheckout.findUnique({
        where: { id: localId },
        include: { customer: true },
      });
  if (
    !checkout ||
    checkout.accountId !== account.id ||
    checkout.stripeCheckoutSessionId !== session.id ||
    checkout.customer.stripeCustomerId !== stripeExternalId(session.customer)
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_CHECKOUT_BINDING_INVALID');
  }
  const occurredAt = new Date(event.created * 1000);
  return {
    event: {
      kind: 'checkout_expired',
      localId,
      localType,
      checkoutSessionId: session.id,
      expiresAt: new Date(session.expires_at * 1000),
    },
    eventFields: {
      stripeObjectId: session.id,
      stripeObjectStatus: session.status,
      stripeCustomerId: stripeExternalId(session.customer),
      stripeCheckoutSessionId: session.id,
      stripeCreatedAt: occurredAt,
    },
  };
}

export async function prepareCreditFundingWebhook(
  event: Stripe.Event,
  stripe: CreditFundingWebhookClient,
  account: StripeAccountContext,
  prisma: PrismaClient,
): Promise<PreparedCreditFundingWebhook | null> {
  return (
    (await preparePaymentIntent(event, stripe, account, prisma)) ??
    (await prepareSetupIntent(event, stripe, account, prisma)) ??
    (await preparePaymentAdjustmentWebhook(event, stripe, account, prisma)) ??
    (await prepareExpiredCheckout(event, stripe, account, prisma))
  );
}
