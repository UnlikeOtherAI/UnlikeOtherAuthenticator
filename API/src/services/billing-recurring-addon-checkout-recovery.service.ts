import { BillingRecurringAddonCheckoutStatus, type BillingRecurringAddonCheckout, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import type { BillingHostedRedirectResponse } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import type { StripeCheckoutClient } from './billing-stripe-checkout-state.service.js';
import { assertStripeObjectLivemode } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

export function redirect(session: Stripe.Checkout.Session): BillingHostedRedirectResponse {
  if (session.status !== 'open' || !session.url || !session.url.startsWith('https://')) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_RECURRING_ADDON_CHECKOUT_NOT_OPEN');
  }
  return { redirect_url: session.url };
}

export async function recoverOpenCheckout(
  checkout: BillingRecurringAddonCheckout,
  expectedCustomerId: string,
  deps: { prisma: PrismaClient; stripe: StripeCheckoutClient; livemode: boolean },
): Promise<{ redirect: BillingHostedRedirectResponse | null; reusable: boolean }> {
  if (!checkout.stripeCheckoutSessionId) return { redirect: null, reusable: true };
  const session = await deps.stripe.checkout.sessions.retrieve(checkout.stripeCheckoutSessionId);
  assertStripeObjectLivemode(session, deps.livemode);
  if (
    session.id !== checkout.stripeCheckoutSessionId ||
    session.client_reference_id !== checkout.id ||
    stripeExternalId(session.customer) !== expectedCustomerId ||
    session.mode !== 'subscription'
  ) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_CHECKOUT_DRIFT');
  }
  if (session.status === 'open') return { redirect: redirect(session), reusable: false };
  if (session.status === 'complete') {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_RECURRING_ADDON_WEBHOOK_PENDING');
  }
  await deps.prisma.billingRecurringAddonCheckout.update({
    where: { id: checkout.id },
    data: {
      status: BillingRecurringAddonCheckoutStatus.EXPIRED,
      leaseExpiresAt: new Date(),
      expiresAt: new Date(session.expires_at * 1000),
    },
  });
  return { redirect: null, reusable: false };
}

