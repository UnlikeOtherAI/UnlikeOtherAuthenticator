import type { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

let cachedClient: Stripe | undefined;

export const STRIPE_BILLING_API_VERSION = '2026-06-24.dahlia' as const;

export type StripeAccountContext = {
  id: string;
  stripeAccountId: string;
  livemode: boolean;
};

function secretKeyLivemode(secretKey: string): boolean {
  const match = /^(?:sk|rk)_(test|live)_/.exec(secretKey);
  if (!match) {
    throw new AppError('INTERNAL', 503, 'STRIPE_SECRET_KEY_MODE_UNKNOWN');
  }
  return match[1] === 'live';
}

export function requireStripeBillingEnabled(): {
  client: Stripe;
  webhookSecret: string;
  livemode: boolean;
} {
  const env = getEnv();
  if (!env.STRIPE_BILLING_ENABLED) {
    throw new AppError('INTERNAL', 503, 'STRIPE_BILLING_DISABLED');
  }
  return requireStripeWebhookConfigured();
}

export function requireStripeWebhookConfigured(): {
  client: Stripe;
  webhookSecret: string;
  livemode: boolean;
} {
  const env = getEnv();
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    throw new AppError('INTERNAL', 503, 'STRIPE_WEBHOOK_DISABLED');
  }
  const livemode = secretKeyLivemode(env.STRIPE_SECRET_KEY);
  cachedClient ??= new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_BILLING_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20_000,
  });
  return { client: cachedClient, webhookSecret: env.STRIPE_WEBHOOK_SECRET, livemode };
}

export async function resolveStripeAccountContext(
  stripe: Pick<Stripe, 'accounts'>,
  livemode: boolean,
  prisma: Pick<PrismaClient, 'billingStripeAccount'> = getAdminPrisma(),
): Promise<StripeAccountContext> {
  const remote = await stripe.accounts.retrieveCurrent();
  if (!remote || typeof remote.id !== 'string' || !remote.id.startsWith('acct_')) {
    throw new AppError('INTERNAL', 502, 'STRIPE_ACCOUNT_IDENTITY_INVALID');
  }
  return prisma.billingStripeAccount.upsert({
    where: {
      stripeAccountId_livemode: {
        stripeAccountId: remote.id,
        livemode,
      },
    },
    create: { stripeAccountId: remote.id, livemode },
    update: {},
  });
}

export function assertStripeObjectLivemode(value: unknown, expected: boolean): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('livemode' in value) ||
    typeof value.livemode !== 'boolean' ||
    value.livemode !== expected
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_OBJECT_MODE_MISMATCH');
  }
}

export function resetStripeClientCache(): void {
  cachedClient = undefined;
}
