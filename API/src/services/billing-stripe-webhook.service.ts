import type { Prisma, PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  assertStripeObjectLivemode,
  requireStripeWebhookConfigured,
  resolveStripeAccountContext,
  STRIPE_BILLING_API_VERSION,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import {
  applyCreditFundingWebhook,
  prepareCreditFundingWebhook,
  type CreditFundingWebhookClient,
} from './billing-credit-funding-webhook.service.js';
import {
  reconcileStripeCycleInvoiceUsage,
  type StripeInvoiceWebhookType,
} from './billing-stripe-invoice.service.js';
import { prepareRecurringAddonWebhook } from './billing-recurring-addon-webhook.service.js';
import { applyRecurringAddonWebhook } from './billing-recurring-addon-webhook-apply.service.js';
import {
  refreshStripeSubscriptionProjection,
  syncBaseStripeSubscription,
  syncStripeSubscriptionProjection,
  terminalizeMissingBaseStripeSubscription,
} from './billing-stripe-subscription-projection.service.js';
import {
  retrieveStripeSubscription,
  stripeExternalId,
} from './billing-stripe-webhook-utils.service.js';

export { refreshStripeSubscriptionProjection, syncStripeSubscriptionProjection };

type StripeWebhookClient = Pick<
  Stripe,
  'accounts' | 'billing' | 'checkout' | 'invoices' | 'subscriptions' | 'webhooks'
> &
  CreditFundingWebhookClient;

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.pending_update_applied',
  'customer.subscription.resumed',
]);
const INVOICE_RECONCILIATION_EVENTS = new Set<StripeInvoiceWebhookType>([
  'invoice.created',
  'invoice.finalization_failed',
]);

type CurrentEventState = {
  checkoutSession: Stripe.Checkout.Session | null;
  subscriptionId: string | null;
  subscription: Stripe.Subscription | null;
};

function hasUoaMetadata(metadata: Stripe.Metadata | null | undefined): boolean {
  return Object.keys(metadata ?? {}).some((key) => key.startsWith('uoa_'));
}

function uoaMetadataFingerprint(metadata: Stripe.Metadata | null | undefined): string {
  return Object.entries(metadata ?? {})
    .filter(([key]) => key.startsWith('uoa_'))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}\0${value}`)
    .join('\0');
}

function assertSameUoaMetadata(
  signed: Stripe.Metadata | null | undefined,
  current: Stripe.Metadata | null | undefined,
): void {
  if (uoaMetadataFingerprint(signed) !== uoaMetadataFingerprint(current)) {
    throw new AppError('INTERNAL', 503, 'STRIPE_WEBHOOK_BINDING_STATE_DRIFT');
  }
}

async function currentEventState(
  event: Stripe.Event,
  stripe: StripeWebhookClient,
  account: StripeAccountContext,
): Promise<CurrentEventState> {
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.expired') {
    const payload = event.data.object as Stripe.Checkout.Session;
    const session = await stripe.checkout.sessions.retrieve(payload.id);
    assertStripeObjectLivemode(session, account.livemode);
    if (payload.mode !== session.mode) {
      if (hasUoaMetadata(payload.metadata) || hasUoaMetadata(session.metadata)) {
        throw new AppError('INTERNAL', 503, 'STRIPE_WEBHOOK_BINDING_STATE_DRIFT');
      }
      return { checkoutSession: null, subscriptionId: null, subscription: null };
    }
    if (session.mode !== 'subscription') {
      return { checkoutSession: null, subscriptionId: null, subscription: null };
    }
    assertSameUoaMetadata(payload.metadata, session.metadata);
    if (!hasUoaMetadata(payload.metadata)) {
      return { checkoutSession: null, subscriptionId: null, subscription: null };
    }
    const subscriptionId = stripeExternalId(session.subscription);
    return {
      checkoutSession: session,
      subscriptionId,
      subscription: subscriptionId
        ? await retrieveStripeSubscription(stripe, subscriptionId)
        : null,
    };
  }
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const payload = event.data.object as Stripe.Subscription;
    const subscription = await retrieveStripeSubscription(stripe, payload.id);
    if (!subscription) {
      return {
        checkoutSession: null,
        subscriptionId: hasUoaMetadata(payload.metadata) ? payload.id : null,
        subscription: null,
      };
    }
    assertSameUoaMetadata(payload.metadata, subscription.metadata);
    if (!hasUoaMetadata(payload.metadata)) {
      return { checkoutSession: null, subscriptionId: null, subscription: null };
    }
    return {
      checkoutSession: null,
      subscriptionId: payload.id,
      subscription,
    };
  }
  return { checkoutSession: null, subscriptionId: null, subscription: null };
}

async function syncCheckoutSession(
  tx: Prisma.TransactionClient,
  session: Stripe.Checkout.Session,
  account: StripeAccountContext,
): Promise<void> {
  assertStripeObjectLivemode(session, account.livemode);
  const checkoutId = session.metadata?.uoa_checkout_id ?? session.client_reference_id;
  if (!checkoutId) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CHECKOUT_BINDING_INVALID');
  }
  const checkout = await tx.billingStripeCheckoutSession.findUnique({
    where: { id: checkoutId },
    include: { customer: true },
  });
  if (
    !checkout ||
    checkout.accountId !== account.id ||
    (checkout.stripeCheckoutSessionId && checkout.stripeCheckoutSessionId !== session.id) ||
    stripeExternalId(session.customer) !== checkout.customer.stripeCustomerId ||
    session.mode !== 'subscription'
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CHECKOUT_BINDING_INVALID');
  }
  await tx.billingStripeCheckoutSession.update({
    where: { id: checkout.id },
    data: {
      stripeCheckoutSessionId: session.id,
      status: session.status ?? checkout.status,
      expiresAt: new Date(session.expires_at * 1000),
      ...(session.status === 'complete' && !checkout.completedAt
        ? { completedAt: new Date() }
        : {}),
    },
  });
}

async function processEvent(
  tx: Prisma.TransactionClient,
  state: CurrentEventState,
  account: StripeAccountContext,
): Promise<void> {
  if (state.checkoutSession) {
    await syncCheckoutSession(tx, state.checkoutSession, account);
  }
  if (state.subscription) {
    await syncBaseStripeSubscription(tx, state.subscription, account);
  } else if (state.subscriptionId) {
    await terminalizeMissingBaseStripeSubscription(tx, account, state.subscriptionId);
  }
}

export async function handleStripeWebhook(
  params: { rawBody: Buffer; signature: string },
  deps?: {
    prisma?: PrismaClient;
    stripe?: StripeWebhookClient;
    stripeLivemode?: boolean;
    webhookSecret?: string;
    collectionEnabled?: boolean;
    reconcileInvoice?: typeof reconcileStripeCycleInvoiceUsage;
  },
): Promise<{ duplicate: boolean }> {
  const configured = deps?.stripe ? undefined : requireStripeWebhookConfigured();
  const stripe = (deps?.stripe ?? configured?.client) as StripeWebhookClient | undefined;
  const webhookSecret = deps?.webhookSecret ?? configured?.webhookSecret;
  if (!stripe || !webhookSecret) {
    throw new AppError('INTERNAL', 503, 'STRIPE_BILLING_DISABLED');
  }
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(params.rawBody, params.signature, webhookSecret);
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_STRIPE_WEBHOOK_SIGNATURE');
  }
  if (event.api_version !== STRIPE_BILLING_API_VERSION) {
    throw new AppError('BAD_REQUEST', 400, 'STRIPE_WEBHOOK_API_VERSION_UNSUPPORTED');
  }

  const prisma = deps?.prisma ?? getAdminPrisma();
  const livemode = deps?.stripeLivemode ?? configured?.livemode ?? false;
  const account = await resolveStripeAccountContext(stripe, livemode, prisma);
  if (
    event.livemode !== account.livemode ||
    (event.account && event.account !== account.stripeAccountId)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'STRIPE_WEBHOOK_ACCOUNT_MISMATCH');
  }
  const eventKey = {
    accountId_stripeEventId: {
      accountId: account.id,
      stripeEventId: event.id,
    },
  };
  if (await prisma.billingStripeWebhookEvent.findUnique({ where: eventKey })) {
    return { duplicate: true };
  }
  const collectionEnabled = deps?.collectionEnabled ?? getEnv().STRIPE_BILLING_ENABLED;
  const recurringAddon = await prepareRecurringAddonWebhook(event, stripe, account, prisma);
  if (
    !recurringAddon &&
    !collectionEnabled &&
    INVOICE_RECONCILIATION_EVENTS.has(event.type as StripeInvoiceWebhookType)
  ) {
    throw new AppError('INTERNAL', 503, 'STRIPE_INVOICE_RECONCILIATION_DISABLED');
  }
  const state = recurringAddon
    ? { checkoutSession: null, subscriptionId: null, subscription: null }
    : await currentEventState(event, stripe, account);
  const creditFunding = await prepareCreditFundingWebhook(event, stripe, account, prisma);
  if (recurringAddon && creditFunding) {
    throw new AppError('INTERNAL', 503, 'STRIPE_WEBHOOK_BINDING_AMBIGUOUS');
  }
  if (
    !recurringAddon &&
    collectionEnabled &&
    INVOICE_RECONCILIATION_EVENTS.has(event.type as StripeInvoiceWebhookType)
  ) {
    const invoice = event.data.object as Stripe.Invoice;
    if (!invoice.id) {
      throw new AppError('BAD_REQUEST', 400, 'STRIPE_INVOICE_BINDING_INVALID');
    }
    await (deps?.reconcileInvoice ?? reconcileStripeCycleInvoiceUsage)(
      {
        invoiceId: invoice.id,
        eventType: event.type as StripeInvoiceWebhookType,
        account,
      },
      { prisma, stripe },
    );
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
          ...(recurringAddon?.eventFields ?? creditFunding?.eventFields),
        },
      });
      await processEvent(tx, state, account);
      if (recurringAddon) {
        await applyRecurringAddonWebhook(tx, recurringAddon, webhookEvent.id, account);
      }
      if (creditFunding) {
        await applyCreditFundingWebhook(tx, creditFunding, webhookEvent.id, account);
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
