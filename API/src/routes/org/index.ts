import type { FastifyInstance } from 'fastify';

import { registerOrgMeRoute } from './me.js';
import { registerOrganisationRoutes } from './organisations.js';

export function registerOrgRoutes(app: FastifyInstance): void {
  registerOrgMeRoute(app);
  registerOrganisationRoutes(app);
}
