import type { FastifyInstance } from 'fastify';

import { registerOrgMeRoute } from './me.js';
import { registerOrganisationRoutes } from './organisations.js';
import { registerGroupRoutes } from './groups.js';
import { registerTeamRoutes } from './teams.js';

export function registerOrgRoutes(app: FastifyInstance): void {
  registerOrgMeRoute(app);
  registerOrganisationRoutes(app);
  registerGroupRoutes(app);
  registerTeamRoutes(app);
}
