import type { FastifyInstance } from 'fastify';

import { registerInternalAdminConfigRoute } from './config.js';
import { registerInternalAdminDomainJwkRoutes } from './domain-jwks.js';
import { registerInternalAdminDomainRoutes } from './domains.js';
import { registerInternalAdminIntegrationRequestRoutes } from './integration-requests.js';
import { registerInternalAdminReadRoutes } from './read.js';
import { registerInternalAdminTokenRoute } from './token.js';

export function registerInternalAdminRoutes(app: FastifyInstance): void {
  registerInternalAdminConfigRoute(app);
  registerInternalAdminTokenRoute(app);
  registerInternalAdminReadRoutes(app);
  registerInternalAdminDomainRoutes(app);
  registerInternalAdminDomainJwkRoutes(app);
  registerInternalAdminIntegrationRequestRoutes(app);
}
