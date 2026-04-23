import type { FastifyInstance } from 'fastify';

import { registerInternalAdminConfigRoute } from './config.js';
import { registerInternalAdminDomainEmailRoutes } from './domain-email.js';
import { registerInternalAdminDomainJwkRoutes } from './domain-jwks.js';
import { registerInternalAdminDomainRoutes } from './domains.js';
import { registerInternalAdminIntegrationRequestRoutes } from './integration-requests.js';
import { registerInternalAdminReadRoutes } from './read.js';
import { registerInternalAdminSuperuserRoutes } from './superusers.js';
import { registerInternalAdminTokenRoute } from './token.js';

export function registerInternalAdminRoutes(app: FastifyInstance): void {
  registerInternalAdminConfigRoute(app);
  registerInternalAdminTokenRoute(app);
  registerInternalAdminReadRoutes(app);
  registerInternalAdminDomainRoutes(app);
  registerInternalAdminDomainEmailRoutes(app);
  registerInternalAdminDomainJwkRoutes(app);
  registerInternalAdminSuperuserRoutes(app);
  registerInternalAdminIntegrationRequestRoutes(app);
}
