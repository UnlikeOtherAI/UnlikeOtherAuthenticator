import type { Prisma, PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { applyCreditFundingWebhook } from './billing-credit-funding-webhook.service.js';
import { prepareCreditFundingWebhook } from './billing-credit-funding-webhook-prepare.service.js';
import type { PreparedCreditFundingWebhook } from './billing-credit-funding-webhook.types.js';
import type { CreditFundingWebhookClient } from './billing-credit-funding-webhook.types.js';
import {
  STRIPE_BILLING_API_VERSION,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';

export function assertStripeEventApiVersion(event: Stripe.Event): void {
  if (event.api_version !== STRIPE_BILLING_API_VERSION) {
    throw new AppError('BAD_REQUEST', 400, 'STRIPE_WEBHOOK_API_VERSION_UNSUPPORTED');
  }
}

const CREDIT_PAYMENT_INTENT_EVENT_TYPES = new Set([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.processing',
  'payment_intent.requires_action',
  'payment_intent.canceled',
]);

/**
 * Process an original Stripe Event obtained through the authenticated Stripe client.
 * This internal path is used by scheduled recovery; HTTP events must still pass
 * through webhook signature verification before reaching the shared commit path.
 */
export async function applyTrustedCreditFundingStripeEvent(params: {
  event: Stripe.Event;
  expectedPaymentIntentId: string;
  stripe: CreditFundingWebhookClient;
  account: StripeAccountContext;
  prisma: PrismaClient;
}): Promise<{ duplicate: boolean; applied: boolean }> {
  const { event, account, prisma, stripe } = params;
  assertStripeEventApiVersion(event);
  assertStripeEventAccount(event, account);
  if (!CREDIT_PAYMENT_INTENT_EVENT_TYPES.has(event.type)) {
    throw new AppError('BAD_REQUEST', 400, 'STRIPE_CREDIT_EVENT_TYPE_UNSUPPORTED');
  }
  const payload = event.data.object as Stripe.PaymentIntent;
  if (payload.id !== params.expectedPaymentIntentId) {
    throw new AppError('BAD_REQUEST', 400, 'STRIPE_CREDIT_EVENT_BINDING_INVALID');
  }
  const prepared = await prepareCreditFundingWebhook(event, stripe, account, prisma);
  if (!prepared) return { duplicate: false, applied: false };
  const result = await commitVerifiedStripeEvent({ event, account, prisma, prepared });
  return { ...result, applied: !result.duplicate };
}

export function assertStripeEventAccount(event: Stripe.Event, account: StripeAccountContext): void {
  if (
    event.livemode !== account.livemode ||
    (event.account && event.account !== account.stripeAccountId)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'STRIPE_WEBHOOK_ACCOUNT_MISMATCH');
  }
}

export async function commitVerifiedStripeEvent(params: {
  event: Stripe.Event;
  account: StripeAccountContext;
  prisma: PrismaClient;
  prepared: PreparedCreditFundingWebhook | null;
  extraEventFields?: Partial<Prisma.BillingStripeWebhookEventUncheckedCreateInput>;
  applyAdditional?: (tx: Prisma.TransactionClient, webhookEventId: string) => Promise<void>;
}): Promise<{ duplicate: boolean }> {
  const { event, account, prisma } = params;
  const eventKey = {
    accountId_stripeEventId: { accountId: account.id, stripeEventId: event.id },
  };
  if (await prisma.billingStripeWebhookEvent.findUnique({ where: eventKey })) {
    return { duplicate: true };
  }
  try {
    await prisma.$transaction(async (tx) => {
      const webhookEvent = await tx.billingStripeWebhookEvent.create({
        data: {
          accountId: account.id,
          stripeEventId: event.id,
          type: event.type,
          apiVersion: event.api_version,
          livemode: event.livemode,
          stripeCreatedAt: new Date(event.created * 1000),
          ...(params.extraEventFields ?? params.prepared?.eventFields),
        },
      });
      await params.applyAdditional?.(tx, webhookEvent.id);
      if (params.prepared) {
        await applyCreditFundingWebhook(tx, params.prepared, webhookEvent.id, account);
      }
    });
    return { duplicate: false };
  } catch (error) {
    if (
      (error as { code?: unknown } | null)?.code === 'P2002' &&
      (await prisma.billingStripeWebhookEvent.findUnique({ where: eventKey }))
    ) {
      return { duplicate: true };
    }
    throw error;
  }
}
