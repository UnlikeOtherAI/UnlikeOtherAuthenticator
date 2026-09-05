import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import {
  assertDatabaseEnabled,
  getOrganisationMember,
  resolveOrgActor,
  teamAvatarImageUrl,
  type OrgActorProvenance,
  type OrgServiceDeps,
  type OrgServicePrisma,
} from './organisation.service.base.js';
import { resolveMemberManagementTeamScope } from './team-invite.service.roster.js';
import { AppError } from '../utils/errors.js';

export type MemberTeamAccess = {
  id: string;
  name: string;
  slug: string;
  avatarImageUrl: string;
  /** Whether the selected organisation member is actively in this team. */
  hasAccess: boolean;
};

export type MemberTeamAccessResult = {
  data: MemberTeamAccess[];
  permissions: { changeTeamAccess: boolean };
};

/**
 * A manager's editable portion of one member's team access.
 *
 * Team membership belongs to UOA. The response therefore includes only exact
 * teams where this caller currently holds `members.manage`; memberships in
 * other teams are neither disclosed nor changed by a product UI.
 */
export async function listMemberTeamAccess(
  params: {
    orgId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    userId: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<MemberTeamAccessResult> {
  assertDatabaseEnabled(deps?.env ?? getEnv());

  const actorUserId = resolveOrgActor(params);
  const userId = params.userId.trim();
  if (!userId) throw new AppError('BAD_REQUEST', 400);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const scope = await resolveMemberManagementTeamScope(prisma, {
    orgId: params.orgId,
    actorUserId,
    config: params.config,
  });
  const target = await getOrganisationMember(
    prisma,
    { orgId: scope.org.id, userId },
    { activeOnly: true },
  );
  if (!target) throw new AppError('NOT_FOUND', 404);

  if (scope.teamIds?.length === 0) {
    return { data: [], permissions: { changeTeamAccess: false } };
  }

  const teams = await prisma.team.findMany({
    where: {
      orgId: scope.org.id,
      ...(scope.teamIds === null ? {} : { id: { in: scope.teamIds } }),
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      slug: true,
      members: {
        where: { userId, status: 'ACTIVE' },
        select: { id: true },
      },
    },
  });

  return {
    data: teams.map((team) => ({
      id: team.id,
      name: team.name,
      slug: team.slug,
      avatarImageUrl: teamAvatarImageUrl(scope.org.domain, team.id),
      hasAccess: team.members.length > 0,
    })),
    permissions: { changeTeamAccess: true },
  };
}
