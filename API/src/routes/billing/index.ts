import type { FastifyInstance } from 'fastify';

import { registerBillingCancellationRoutes } from './cancellation.js';
import { registerCustomerStatementRoutes } from './customer-statement.js';
import { registerEffectiveTariffRoute } from './effective-tariff.js';
import { registerBillingJwksRoute } from './jwks.js';
import { registerBillingServiceAccessRoutes } from './service-access.js';
import { registerBillingServiceJwksRoute } from './service-jwks.js';
import { registerStripeCheckoutRoute } from './stripe-checkout.js';
import { registerStripeSubscriptionRoutes } from './stripe-subscription.js';
import { registerStripeWebhookRoute } from './stripe-webhook.js';

export function registerBillingRoutes(app: FastifyInstance): void {
  registerBillingCancellationRoutes(app);
  registerCustomerStatementRoutes(app);
  registerBillingServiceAccessRoutes(app);
  registerBillingJwksRoute(app);
  registerBillingServiceJwksRoute(app);
  registerEffectiveTariffRoute(app);
  registerStripeCheckoutRoute(app);
  registerStripeSubscriptionRoutes(app);
  registerStripeWebhookRoute(app);
}
