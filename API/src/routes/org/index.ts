import type { FastifyInstance } from 'fastify';

import { registerOrgMeRoute } from './me.js';
import { registerOrganisationRoutes } from './organisations.js';
import { registerOrganisationMemberRoutes } from './organisation-members.js';
import { registerGroupRoutes } from './groups.js';
import { registerTeamAvatarRoutes } from './team-avatar.js';
import { registerTeamRoutes } from './teams.js';
import { registerTeamSelfJoinRoute } from './team-self-join.js';
import { registerAccessRequestRoutes } from './access-requests.js';
import { registerTeamInvitationRoutes } from './team-invitations.js';
import { registerTeamInviteLinkRoutes } from './team-invite-links.js';
import { registerInvitationApprovalRoutes } from './invitation-approvals.js';
import { registerMemberInvitationRoutes } from './member-invitations.js';
import { registerAutomaticMembershipRoutes } from './automatic-membership.js';

export function registerOrgRoutes(app: FastifyInstance): void {
  registerAutomaticMembershipRoutes(app);
  registerOrgMeRoute(app);
  registerOrganisationRoutes(app);
  registerOrganisationMemberRoutes(app);
  registerGroupRoutes(app);
  registerTeamRoutes(app);
  registerTeamAvatarRoutes(app);
  registerTeamSelfJoinRoute(app);
  registerTeamInvitationRoutes(app);
  registerTeamInviteLinkRoutes(app);
  registerInvitationApprovalRoutes(app);
  registerMemberInvitationRoutes(app);
  registerAccessRequestRoutes(app);
}
