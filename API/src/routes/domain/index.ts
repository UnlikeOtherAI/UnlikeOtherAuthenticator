import type { FastifyInstance } from 'fastify';

import { registerDomainDebugRoute } from './debug.js';
import { registerDomainLogsRoute } from './logs.js';
import { registerDomainUsersRoute } from './users.js';

export function registerDomainRoutes(app: FastifyInstance): void {
  registerDomainDebugRoute(app);
  registerDomainLogsRoute(app);
  registerDomainUsersRoute(app);
}
