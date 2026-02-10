import type { FastifyInstance } from 'fastify';

import { registerDomainLogsRoute } from './logs.js';

export function registerDomainRoutes(app: FastifyInstance): void {
  registerDomainLogsRoute(app);
}

