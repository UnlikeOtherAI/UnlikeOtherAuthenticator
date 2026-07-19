import Stripe from 'stripe';

import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';

let cachedClient: Stripe | undefined;

export function requireStripeBillingEnabled(): {
  client: Stripe;
  webhookSecret: string;
} {
  const env = getEnv();
  if (!env.STRIPE_BILLING_ENABLED || !env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    throw new AppError('INTERNAL', 503, 'STRIPE_BILLING_DISABLED');
  }
  cachedClient ??= new Stripe(env.STRIPE_SECRET_KEY, {
    maxNetworkRetries: 2,
    timeout: 20_000,
  });
  return { client: cachedClient, webhookSecret: env.STRIPE_WEBHOOK_SECRET };
}

export function resetStripeClientCache(): void {
  cachedClient = undefined;
}
