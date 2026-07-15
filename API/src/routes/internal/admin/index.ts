import type { FastifyInstance } from 'fastify';

import { registerInternalAdminApiKeyRoutes } from './api-keys.js';
import { registerInternalAdminAppRoutes } from './apps.js';
import { registerInternalAdminBanRoutes } from './bans.js';
import { registerInternalAdminConfigRoute } from './config.js';
import { registerInternalAdminDomainEmailRoutes } from './domain-email.js';
import { registerInternalAdminDomainJwkRoutes } from './domain-jwks.js';
import { registerInternalAdminDomainSignatureRoutes } from './domain-signatures.js';
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
  registerInternalAdminApiKeyRoutes(app);
  registerInternalAdminDomainRoutes(app);
  registerInternalAdminDomainEmailRoutes(app);
  registerInternalAdminDomainJwkRoutes(app);
  registerInternalAdminDomainSignatureRoutes(app);
  registerInternalAdminUserRoutes(app);
  registerInternalAdminSuperuserRoutes(app);
  registerInternalAdminIntegrationRequestRoutes(app);
}
