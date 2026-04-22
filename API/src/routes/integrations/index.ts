import type { FastifyInstance } from 'fastify';

import { registerIntegrationClaimRoutes } from './claim.js';

export function registerIntegrationRoutes(app: FastifyInstance): void {
  registerIntegrationClaimRoutes(app);
}
