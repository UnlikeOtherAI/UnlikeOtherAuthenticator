import type { FastifyInstance } from 'fastify';

import { registerOrgMeRoute } from './me.js';
import { registerOrganisationRoutes } from './organisations.js';
import { registerOrganisationMemberRoutes } from './organisation-members.js';
import { registerGroupRoutes } from './groups.js';
import { registerTeamRoutes } from './teams.js';
import { registerTeamSelfJoinRoute } from './team-self-join.js';
import { registerAccessRequestRoutes } from './access-requests.js';
import { registerTeamInvitationRoutes } from './team-invitations.js';
import { registerInvitationApprovalRoutes } from './invitation-approvals.js';

export function registerOrgRoutes(app: FastifyInstance): void {
  registerOrgMeRoute(app);
  registerOrganisationRoutes(app);
  registerOrganisationMemberRoutes(app);
  registerGroupRoutes(app);
  registerTeamRoutes(app);
  registerTeamSelfJoinRoute(app);
  registerTeamInvitationRoutes(app);
  registerInvitationApprovalRoutes(app);
  registerAccessRequestRoutes(app);
}
