import {
  BillingCreditCheckoutStatus,
  type BillingCreditSetupCheckout,
  type BillingCreditTopUpCheckout,
  type PrismaClient,
} from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { assertCreditFundingMetadata } from './billing-credit-funding-binding.service.js';
import {
  assertStripeObjectLivemode,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

type CreditCheckout = BillingCreditTopUpCheckout | BillingCreditSetupCheckout;
type CreditCheckoutKind = 'setup' | 'top_up';
type RecoveryClient = Pick<Stripe, 'checkout'>;

function metadataKey(kind: CreditCheckoutKind) {
  return kind === 'top_up'
    ? ('uoa_credit_top_up_checkout_id' as const)
    : ('uoa_credit_setup_checkout_id' as const);
}

function sessionId(checkout: CreditCheckout): string | null {
  return checkout.stripeCheckoutSessionId;
}

function assertSessionBinding(
  session: Stripe.Checkout.Session,
  checkout: CreditCheckout,
  kind: CreditCheckoutKind,
  customerStripeId: string,
  account: StripeAccountContext,
): void {
  assertStripeObjectLivemode(session, account.livemode);
  const key = metadataKey(kind);
  assertCreditFundingMetadata(
    session.metadata,
    {
      localType: kind,
      localId: checkout.id,
      serviceId: checkout.serviceId,
      appKeyId: checkout.appKeyId,
      creditAccountId: checkout.creditAccountId,
    },
    'STRIPE_CREDIT_CHECKOUT_BINDING_INVALID',
  );
  if (
    session.client_reference_id !== checkout.id ||
    stripeExternalId(session.customer) !== customerStripeId ||
    session.mode !== (kind === 'top_up' ? 'payment' : 'setup') ||
    session.metadata?.[key] !== checkout.id
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_CHECKOUT_BINDING_INVALID');
  }
}

function isMissingStripeResource(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    code?: unknown;
    statusCode?: unknown;
    raw?: { code?: unknown };
  };
  return (
    candidate.code === 'resource_missing' ||
    candidate.raw?.code === 'resource_missing' ||
    candidate.statusCode === 404
  );
}

async function findSession(
  checkout: CreditCheckout,
  kind: CreditCheckoutKind,
  customerStripeId: string,
  account: StripeAccountContext,
  stripe: RecoveryClient,
): Promise<Stripe.Checkout.Session | null> {
  const knownId = sessionId(checkout);
  if (knownId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(knownId);
      assertSessionBinding(session, checkout, kind, customerStripeId, account);
      return session;
    } catch (error) {
      if (!isMissingStripeResource(error)) throw error;
    }
  }

  const matches: Stripe.Checkout.Session[] = [];
  let startingAfter: string | undefined;
  let hasMore = true;
  while (hasMore) {
    const page = await stripe.checkout.sessions.list({
      customer: customerStripeId,
      created: { gte: Math.max(0, Math.floor(checkout.createdAt.getTime() / 1000) - 5) },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const session of page.data) {
      if (
        session.client_reference_id === checkout.id &&
        session.metadata?.[metadataKey(kind)] === checkout.id
      ) {
        assertSessionBinding(session, checkout, kind, customerStripeId, account);
        matches.push(session);
      }
    }
    hasMore = page.has_more;
    if (!hasMore) break;
    const next = page.data.at(-1)?.id;
    if (!next || next === startingAfter) {
      throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_CHECKOUT_RECONCILIATION_STALLED');
    }
    startingAfter = next;
  }
  if (matches.length > 1) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_CHECKOUT_DUPLICATED');
  }
  return matches[0] ?? null;
}

function localStatus(session: Stripe.Checkout.Session): BillingCreditCheckoutStatus {
  if (session.status === 'expired') return BillingCreditCheckoutStatus.EXPIRED;
  return BillingCreditCheckoutStatus.OPEN;
}

async function updateCheckout(
  prisma: PrismaClient,
  kind: CreditCheckoutKind,
  checkout: CreditCheckout,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const data = {
    stripeCheckoutSessionId: session.id,
    status: localStatus(session),
    expiresAt: new Date(session.expires_at * 1000),
  };
  if (kind === 'top_up') {
    await prisma.billingCreditTopUpCheckout.update({ where: { id: checkout.id }, data });
  } else {
    await prisma.billingCreditSetupCheckout.update({ where: { id: checkout.id }, data });
  }
}

async function abandonCheckout(
  prisma: PrismaClient,
  kind: CreditCheckoutKind,
  checkout: CreditCheckout,
  now: Date,
): Promise<boolean> {
  const where = {
    id: checkout.id,
    status: BillingCreditCheckoutStatus.CREATING,
    leaseExpiresAt: { lte: now },
    stripeCheckoutSessionId: null,
  };
  const data = { status: BillingCreditCheckoutStatus.ABANDONED };
  const result =
    kind === 'top_up'
      ? await prisma.billingCreditTopUpCheckout.updateMany({ where, data })
      : await prisma.billingCreditSetupCheckout.updateMany({ where, data });
  return result.count === 1;
}

export async function reconcileCreditCheckout(
  params: {
    checkout: CreditCheckout;
    kind: CreditCheckoutKind;
    customerStripeId: string;
    account: StripeAccountContext;
    now: Date;
  },
  deps: { prisma: PrismaClient; stripe: RecoveryClient },
): Promise<{ session: Stripe.Checkout.Session | null; abandoned: boolean }> {
  if (params.checkout.status === BillingCreditCheckoutStatus.COMPLETE) {
    return { session: null, abandoned: false };
  }
  const session = await findSession(
    params.checkout,
    params.kind,
    params.customerStripeId,
    params.account,
    deps.stripe,
  );
  if (session) {
    await updateCheckout(deps.prisma, params.kind, params.checkout, session);
    return { session, abandoned: false };
  }
  const abandoned =
    params.checkout.leaseExpiresAt.getTime() <= params.now.getTime()
      ? await abandonCheckout(deps.prisma, params.kind, params.checkout, params.now)
      : false;
  return { session: null, abandoned };
}

export function creditCheckoutIdempotencyKey(
  account: StripeAccountContext,
  kind: CreditCheckoutKind,
  checkoutId: string,
): string {
  return [
    'uoa',
    account.stripeAccountId,
    account.livemode ? 'live' : 'test',
    'credit',
    kind,
    checkoutId,
  ].join(':');
}
