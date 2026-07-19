import type { FastifyInstance } from 'fastify';

import { registerInternalAdminApiKeyRoutes } from './api-keys.js';
import { registerInternalAdminAppRoutes } from './apps.js';
import { registerInternalAdminBanRoutes } from './bans.js';
import { registerInternalAdminBillingStripeUsageRoute } from './billing-stripe-usage.js';
import { registerInternalAdminBillingRoutes } from './billing.js';
import { registerInternalAdminConfigRoute } from './config.js';
import { registerInternalAdminConfidentialDelegationRoutes } from './confidential-delegations.js';
import { registerInternalAdminDomainEmailRoutes } from './domain-email.js';
import { registerInternalAdminDomainJwkRoutes } from './domain-jwks.js';
import { registerInternalAdminDomainSignatureRoutes } from './domain-signatures.js';
import { registerInternalAdminDomainSignatureOperationRoutes } from './domain-signature-operations.js';
import { registerInternalAdminDomainRoutes } from './domains.js';
import { registerInternalAdminIntegrationRequestRoutes } from './integration-requests.js';
import { registerInternalAdminOrganisationRoutes } from './organisations.js';
import { registerInternalAdminReadRoutes } from './read.js';
import { registerInternalAdminSuperuserRoutes } from './superusers.js';
import { registerInternalAdminTokenRoute } from './token.js';
import { registerInternalAdminUserRoutes } from './users.js';

export function registerInternalAdminRoutes(app: FastifyInstance): void {
  registerInternalAdminConfigRoute(app);
  registerInternalAdminTokenRoute(app);
  registerInternalAdminReadRoutes(app);
  registerInternalAdminOrganisationRoutes(app);
  registerInternalAdminAppRoutes(app);
  registerInternalAdminBanRoutes(app);
  registerInternalAdminBillingRoutes(app);
  registerInternalAdminBillingStripeUsageRoute(app);
  registerInternalAdminConfidentialDelegationRoutes(app);
  registerInternalAdminApiKeyRoutes(app);
  registerInternalAdminDomainRoutes(app);
  registerInternalAdminDomainEmailRoutes(app);
  registerInternalAdminDomainJwkRoutes(app);
  registerInternalAdminDomainSignatureRoutes(app);
  registerInternalAdminDomainSignatureOperationRoutes(app);
  registerInternalAdminUserRoutes(app);
  registerInternalAdminSuperuserRoutes(app);
  registerInternalAdminIntegrationRequestRoutes(app);
}
