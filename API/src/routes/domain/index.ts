import type { FastifyInstance } from 'fastify';

import { registerDomainLogsRoute } from './logs.js';
import { registerDomainUsersRoute } from './users.js';

export function registerDomainRoutes(app: FastifyInstance): void {
  registerDomainLogsRoute(app);
  registerDomainUsersRoute(app);
}
