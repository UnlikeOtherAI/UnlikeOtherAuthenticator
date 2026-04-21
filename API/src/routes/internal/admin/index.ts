import type { FastifyInstance } from 'fastify';

import { registerInternalAdminConfigRoute } from './config.js';
import { registerInternalAdminDomainRoutes } from './domains.js';
import { registerInternalAdminReadRoutes } from './read.js';
import { registerInternalAdminTokenRoute } from './token.js';

export function registerInternalAdminRoutes(app: FastifyInstance): void {
  registerInternalAdminConfigRoute(app);
  registerInternalAdminTokenRoute(app);
  registerInternalAdminReadRoutes(app);
  registerInternalAdminDomainRoutes(app);
}
