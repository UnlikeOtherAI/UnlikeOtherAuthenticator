import type { ClientConfig } from './config.service.js';
import { AppError } from '../utils/errors.js';
import { getOrganisationMember } from './organisation.service.base.js';
import { hasTeamCapability } from './team.service.base.js';
import { normalizeInviteGrantRole, resolveInviteTarget, type InvitePrisma } from './team-invite.service.base.js';

/** Re-read the same invitation policy before preparation and after payment. */
export async function memberInvitePermission(prisma: InvitePrisma, params: {
  orgId: string; teamId: string; actorUserId: string; config: ClientConfig; teamRole?: string;
}): Promise<{ approvalStatus: 'NOT_REQUIRED' | 'PENDING'; teamRole: string }> {
  const { org, team } = await resolveInviteTarget({ prisma, orgId: params.orgId, teamId: params.teamId });
  if (!await getOrganisationMember(prisma, { orgId: org.id, userId: params.actorUserId }, { activeOnly: true })) {
    throw new AppError('FORBIDDEN', 403);
  }
  const manager = await hasTeamCapability(prisma, 'members.manage', { ...params, orgId: org.id, teamId: team.id });
  let approvalStatus: 'NOT_REQUIRED' | 'PENDING' = 'NOT_REQUIRED';
  let roles: string[] | undefined;
  if (!manager) {
    const member = await prisma.teamMember.findFirst({
      where: { teamId: team.id, userId: params.actorUserId, status: 'ACTIVE' }, select: { teamRole: true },
    });
    if (!member || org.memberInvites === 'disabled') throw new AppError('FORBIDDEN', 403);
    if (org.memberInvites === 'admin_approval') approvalStatus = 'PENDING';
    roles = params.config.org_features?.member_invitable_team_roles ?? [];
  }
  if (roles?.length === 0) throw new AppError('FORBIDDEN', 403);
  const teamRole = normalizeInviteGrantRole(params.teamRole ?? roles?.[0], params.config);
  if (roles && !roles.includes(teamRole)) throw new AppError('FORBIDDEN', 403);
  return { approvalStatus, teamRole };
}
