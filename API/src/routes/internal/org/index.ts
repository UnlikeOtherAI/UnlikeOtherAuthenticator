import type { FastifyInstance } from 'fastify';

import { registerInternalGroupMemberRoutes } from './group-members.js';
import { registerInternalGroupRoutes } from './groups.js';
import { registerInternalTeamGroupAssignmentRoutes } from './team-group-assignment.js';

export function registerInternalOrgRoutes(app: FastifyInstance): void {
  registerInternalGroupRoutes(app);
  registerInternalGroupMemberRoutes(app);
  registerInternalTeamGroupAssignmentRoutes(app);
}
