import type { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

const cachedClients = new Map<string, Stripe>();
const expectedAccounts = new WeakMap<object, { accountId: string; livemode: boolean }>();

export const STRIPE_BILLING_API_VERSION = '2026-06-24.dahlia' as const;

export type StripeAccountContext = {
  id: string;
  stripeAccountId: string;
  livemode: boolean;
};

export type StripeBillingMode = 'live' | 'sandbox';
export type StripeRuntime = { client: Stripe; webhookSecret: string; livemode: boolean };

function namedRuntime(mode: StripeBillingMode): StripeRuntime | null {
  const env = getEnv();
  const key = mode === 'live' ? env.STRIPE_LIVE_SECRET_KEY : env.STRIPE_SANDBOX_SECRET_KEY;
  const secret = mode === 'live' ? env.STRIPE_LIVE_WEBHOOK_SECRET : env.STRIPE_SANDBOX_WEBHOOK_SECRET;
  const accountId = mode === 'live' ? env.STRIPE_LIVE_ACCOUNT_ID : env.STRIPE_SANDBOX_ACCOUNT_ID;
  if (!key || !secret || !accountId) return null;
  if (stripeSecretKeyLivemode(key) !== (mode === 'live')) {
    throw new AppError('INTERNAL', 503, 'STRIPE_OBJECT_MODE_MISMATCH');
  }
  return runtime(key, secret, accountId);
}

function runtime(key: string, webhookSecret: string, expectedAccountId?: string): StripeRuntime {
  // Expected identity is part of the cache key: never reuse a client under a different binding.
  const cacheKey = `${key}\0${expectedAccountId ?? ''}`;
  let client = cachedClients.get(cacheKey);
  if (!client) {
    client = new Stripe(key, { apiVersion: STRIPE_BILLING_API_VERSION,
      maxNetworkRetries: 2, timeout: 20_000 });
    cachedClients.set(cacheKey, client);
  }
  if (expectedAccountId) expectedAccounts.set(client, { accountId: expectedAccountId, livemode: stripeSecretKeyLivemode(key) });
  return { client, webhookSecret, livemode: stripeSecretKeyLivemode(key) };
}

/** Captured objects select by BOTH identifiers. Named bindings precede the legacy credential. */
export function stripeRuntimeForAccount(account: StripeAccountContext): StripeRuntime {
  const env = getEnv();
  const mode = account.livemode ? 'live' : 'sandbox';
  const expectedId = account.livemode ? env.STRIPE_LIVE_ACCOUNT_ID : env.STRIPE_SANDBOX_ACCOUNT_ID;
  if (expectedId === account.stripeAccountId) {
    const configured = namedRuntime(mode);
    if (configured) return configured;
  }
  if (env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET &&
    stripeSecretKeyLivemode(env.STRIPE_SECRET_KEY) === account.livemode) {
    return runtime(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET, account.stripeAccountId);
  }
  throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STRIPE_ACCOUNT_NOT_CONFIGURED');
}

/** Signature verification chooses a configured binding before any provider or database work. */
export function verifyStripeWebhookRuntime(rawBody: Buffer, signature: string):
  StripeRuntime & { event: Stripe.Event } {
  const env = getEnv();
  const candidates = [namedRuntime('live'), namedRuntime('sandbox')];
  if (env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET) {
    const legacyMode = stripeSecretKeyLivemode(env.STRIPE_SECRET_KEY);
    // Reusing the original endpoint secret explicitly aliases the historical
    // delivery to that named binding. Use its fresh, account-pinned credential.
    if (!candidates.some((candidate) => candidate?.livemode === legacyMode &&
      candidate.webhookSecret === env.STRIPE_WEBHOOK_SECRET)) {
      candidates.push(runtime(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET));
    }
  }
  const matches: Array<StripeRuntime & { event: Stripe.Event }> = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const event = candidate.client.webhooks.constructEvent(rawBody, signature, candidate.webhookSecret);
      if (event.livemode !== candidate.livemode) continue;
      matches.push({ ...candidate, event });
    } catch { /* Another independently configured endpoint secret may match. */ }
  }
  const matched = matches[0];
  if (matches.length !== 1 || !matched) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_STRIPE_WEBHOOK_SIGNATURE');
  }
  return matched;
}

export function stripeSecretKeyLivemode(secretKey: string): boolean {
  const match = /^(?:sk|rk)_(test|live)_/.exec(secretKey);
  if (!match) {
    throw new AppError('INTERNAL', 503, 'STRIPE_SECRET_KEY_MODE_UNKNOWN');
  }
  return match[1] === 'live';
}

export function requireStripeBillingEnabled(selection: StripeBillingMode | StripeAccountContext = 'live'): StripeRuntime {
  const env = getEnv();
  if (!env.STRIPE_BILLING_ENABLED) {
    throw new AppError('INTERNAL', 503, 'STRIPE_BILLING_DISABLED');
  }
  if (typeof selection !== 'string') return stripeRuntimeForAccount(selection);
  const configured = namedRuntime(selection);
  if (!configured) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STRIPE_MODE_NOT_CONFIGURED');
  return configured;
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
  return runtime(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET);
}

export async function resolveStripeAccountContext(
  stripe: Pick<Stripe, 'accounts'>,
  livemode: boolean,
  prisma: Pick<PrismaClient, 'billingStripeAccount'> = getAdminPrisma(),
): Promise<StripeAccountContext> {
  const remote = await stripe.accounts.retrieveCurrent().catch((error: unknown) => {
    if (
      error instanceof Stripe.errors.StripeAuthenticationError ||
      error instanceof Stripe.errors.StripePermissionError ||
      error instanceof Stripe.errors.StripeConnectionError ||
      error instanceof Stripe.errors.StripeAPIError ||
      error instanceof Stripe.errors.StripeRateLimitError
    ) {
      // This is UOA's provider dependency, never a refusal of the human actor.
      // Do not retain Stripe's message/cause: it may contain credential details.
      throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_PAYMENT_PROVIDER_UNAVAILABLE');
    }
    throw error;
  });
  if (!remote || typeof remote.id !== 'string' || !remote.id.startsWith('acct_')) {
    throw new AppError('INTERNAL', 502, 'STRIPE_ACCOUNT_IDENTITY_INVALID');
  }
  const expected = expectedAccounts.get(stripe);
  if (expected && (remote.id !== expected.accountId || livemode !== expected.livemode)) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STRIPE_ACCOUNT_MISMATCH');
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
  cachedClients.clear();
}
