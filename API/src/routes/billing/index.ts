import type { FastifyInstance } from 'fastify';

import { registerBillingCancellationRoutes } from './cancellation.js';
import { registerBillingCreditFundingActionRoutes } from './credit-funding-actions.js';
import { registerBillingCreditsRoute } from './credits.js';
import { registerBillingCycleRoutes } from './cycles.js';
import { registerBillingCustomerInvoiceRoutes } from './customer-invoices.js';
import { registerCustomerStatementRoutes } from './customer-statement.js';
import { registerEffectiveTariffRoute } from './effective-tariff.js';
import { registerBillingOrgResponsibilityRoutes } from './org-responsibility.js';
import { registerBillingFundingArtifactRoutes } from './funding-artifacts.js';
import { registerBillingJwksRoute } from './jwks.js';
import { registerJobComputeRenewalRoutes } from './job-compute-renewals.js';
import { registerLedgerReservationRoutes } from './ledger-reservations.js';
import { registerBillingServiceAccessRoutes } from './service-access.js';
import { registerBillingServiceJwksRoute } from './service-jwks.js';
import { registerBillingRecurringAddonsRoute } from './recurring-addons.js';
import { registerStripeCheckoutRoute } from './stripe-checkout.js';
import { registerStripeSubscriptionRoutes } from './stripe-subscription.js';
import { registerStripeWebhookRoute } from './stripe-webhook.js';

export function registerBillingRoutes(app: FastifyInstance): void {
  registerBillingCancellationRoutes(app);
  registerBillingCreditFundingActionRoutes(app);
  registerBillingCreditsRoute(app);
  registerBillingCycleRoutes(app);
  registerBillingCustomerInvoiceRoutes(app);
  registerBillingRecurringAddonsRoute(app);
  registerBillingFundingArtifactRoutes(app);
  registerCustomerStatementRoutes(app);
  registerBillingServiceAccessRoutes(app);
  registerBillingJwksRoute(app);
  registerJobComputeRenewalRoutes(app);
  registerLedgerReservationRoutes(app);
  registerBillingServiceJwksRoute(app);
  registerEffectiveTariffRoute(app);
  registerBillingOrgResponsibilityRoutes(app);
  registerStripeCheckoutRoute(app);
  registerStripeSubscriptionRoutes(app);
  registerStripeWebhookRoute(app);
}
