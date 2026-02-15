import type { FastifyInstance } from 'fastify';

import { registerOrgMeRoute } from './me.js';

export function registerOrgRoutes(app: FastifyInstance): void {
  registerOrgMeRoute(app);
}

