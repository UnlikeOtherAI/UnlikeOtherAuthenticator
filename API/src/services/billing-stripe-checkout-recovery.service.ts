import type { BillingStripeCheckoutSession, PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import {
  assertStripeObjectLivemode,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';

export type StripeCheckoutRecoveryClient = Pick<Stripe, 'checkout'>;

function externalId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
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

function assertSessionBinding(
  session: Stripe.Checkout.Session,
  checkout: BillingStripeCheckoutSession,
  customerId: string,
  account: StripeAccountContext,
): void {
  assertStripeObjectLivemode(session, account.livemode);
  if (
    session.client_reference_id !== checkout.id ||
    session.metadata?.uoa_checkout_id !== checkout.id ||
    externalId(session.customer) !== customerId ||
    session.mode !== 'subscription'
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CHECKOUT_BINDING_INVALID');
  }
}

async function findCheckoutSession(
  checkout: BillingStripeCheckoutSession,
  customerId: string,
  stripe: StripeCheckoutRecoveryClient,
  account: StripeAccountContext,
): Promise<Stripe.Checkout.Session | null> {
  if (checkout.stripeCheckoutSessionId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(checkout.stripeCheckoutSessionId);
      assertSessionBinding(session, checkout, customerId, account);
      return session;
    } catch (error) {
      if (!isMissingStripeResource(error)) throw error;
    }
  }

  const matches: Stripe.Checkout.Session[] = [];
  let startingAfter: string | undefined;
  let hasMore = true;
  do {
    const page = await stripe.checkout.sessions.list({
      customer: customerId,
      created: {
        gte: Math.max(0, Math.floor(checkout.createdAt.getTime() / 1000) - 5),
      },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const session of page.data) {
      if (
        session.client_reference_id === checkout.id &&
        session.metadata?.uoa_checkout_id === checkout.id
      ) {
        assertSessionBinding(session, checkout, customerId, account);
        matches.push(session);
      }
    }
    hasMore = page.has_more;
    if (!hasMore) break;
    const next = page.data.at(-1)?.id;
    if (!next || next === startingAfter) {
      throw new AppError('INTERNAL', 502, 'STRIPE_CHECKOUT_RECONCILIATION_STALLED');
    }
    startingAfter = next;
  } while (hasMore);

  if (matches.length > 1) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CHECKOUT_DUPLICATED');
  }
  return matches[0] ?? null;
}

export async function reconcileStripeCheckoutLease(
  params: {
    checkout: BillingStripeCheckoutSession;
    customerStripeId: string;
    account: StripeAccountContext;
    now: Date;
  },
  deps: {
    prisma: Pick<PrismaClient, 'billingStripeCheckoutSession'>;
    stripe: StripeCheckoutRecoveryClient;
  },
): Promise<{
  checkout: BillingStripeCheckoutSession;
  session: Stripe.Checkout.Session | null;
  abandoned: boolean;
}> {
  const session = await findCheckoutSession(
    params.checkout,
    params.customerStripeId,
    deps.stripe,
    params.account,
  );
  if (session) {
    const updated = await deps.prisma.billingStripeCheckoutSession.update({
      where: { id: params.checkout.id },
      data: {
        stripeCheckoutSessionId: session.id,
        status: session.status ?? params.checkout.status,
        expiresAt: new Date(session.expires_at * 1000),
        ...(session.status === 'complete' && !params.checkout.completedAt
          ? { completedAt: params.now }
          : {}),
      },
    });
    return { checkout: updated, session, abandoned: false };
  }

  if (
    params.checkout.status === 'creating' &&
    params.checkout.leaseExpiresAt.getTime() <= params.now.getTime()
  ) {
    const result = await deps.prisma.billingStripeCheckoutSession.updateMany({
      where: {
        id: params.checkout.id,
        status: 'creating',
        leaseExpiresAt: { lte: params.now },
        stripeCheckoutSessionId: null,
      },
      data: { status: 'abandoned' },
    });
    return {
      checkout: params.checkout,
      session: null,
      abandoned: result.count === 1,
    };
  }

  return {
    checkout: params.checkout,
    session: null,
    abandoned: false,
  };
}

export function checkoutIdempotencyKey(account: StripeAccountContext, checkoutId: string): string {
  return `uoa:${account.stripeAccountId}:${account.livemode ? 'live' : 'test'}:checkout:${checkoutId}`;
}
