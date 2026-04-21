import type { FastifyInstance } from 'fastify';

import { registerInternalAdminReadRoutes } from './read.js';
import { registerInternalAdminTokenRoute } from './token.js';

export function registerInternalAdminRoutes(app: FastifyInstance): void {
  registerInternalAdminTokenRoute(app);
  registerInternalAdminReadRoutes(app);
}
