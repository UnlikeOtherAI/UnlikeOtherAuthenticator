import type { FastifyInstance } from 'fastify';

import { registerEffectiveTariffRoute } from './effective-tariff.js';
import { registerBillingJwksRoute } from './jwks.js';
import { registerBillingServiceJwksRoute } from './service-jwks.js';
import { registerStripeCheckoutRoute } from './stripe-checkout.js';
import { registerStripeSubscriptionRoutes } from './stripe-subscription.js';
import { registerStripeWebhookRoute } from './stripe-webhook.js';

export function registerBillingRoutes(app: FastifyInstance): void {
  registerBillingJwksRoute(app);
  registerBillingServiceJwksRoute(app);
  registerEffectiveTariffRoute(app);
  registerStripeCheckoutRoute(app);
  registerStripeSubscriptionRoutes(app);
  registerStripeWebhookRoute(app);
}
