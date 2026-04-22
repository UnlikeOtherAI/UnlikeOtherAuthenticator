import type { FastifyInstance } from 'fastify';

import { registerAppStartupRoute } from './startup.js';

export function registerAppRoutes(app: FastifyInstance): void {
  registerAppStartupRoute(app);
}
