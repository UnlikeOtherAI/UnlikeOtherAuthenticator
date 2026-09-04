import type { ClientConfig } from './config.service.js';

import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  decodeRosterCursor,
  rosterKeysetWhere,
  rosterOrder,
  rosterPaginationMeta,
  type RosterDirection,
  type RosterPaginationMeta,
} from './roster-pagination.service.js';
import {
  assertDatabaseEnabled,
  getOrganisationMember,
  resolveOrgActor,
  resolveOrganisation,
  teamAvatarImageUrl,
  toListLimit,
  type OrgActorProvenance,
} from './organisation.service.base.js';
import { configRoleHoldsCapability } from './role-grants.js';
import {
  ACTIONABLE_TEAM_INVITE_WHERE,
  TEAM_INVITE_SELECT,
  getEnv,
  toInviteRecord,
  type InviteDeps,
  type InvitePrisma,
  type TeamInviteRecord,
} from './team-invite.service.base.js';

type InvitationScope = {
  org: Awaited<ReturnType<typeof resolveOrganisation>>;
  /** `null` is every team in the organisation (backend or org-level manager). */
  teamIds: string[] | null;
};

export type InvitationTarget = {
  id: string;
  name: string;
  slug: string;
  avatarImageUrl: string;
};

export type InvitationTargetPage = {
  data: InvitationTarget[];
  total: number;
  meta: RosterPaginationMeta;
  permissions: { createInvitation: boolean };
};

export type PendingInvitation = TeamInviteRecord & {
  team: InvitationTarget;
};

export type PendingInvitationPage = {
  data: PendingInvitation[];
  total: number;
  meta: RosterPaginationMeta;
  permissions: {
    createInvitation: boolean;
    viewPendingInvitations: boolean;
  };
};

/**
 * Resolves exactly the teams in which the caller can manage members. The
 * result is deliberately membership-rooted: neither roster may be broadened
 * into a domain-wide directory or infer authority from a selected UI team.
 */
async function resolveInvitationScope(
  prisma: InvitePrisma,
  params: {
    orgId: string;
    actorUserId: string | undefined;
    config: ClientConfig;
  },
): Promise<InvitationScope> {
  const org = await resolveOrganisation(prisma, { orgId: params.orgId });
  if (!params.actorUserId) return { org, teamIds: null };

  const orgMember = await getOrganisationMember(
    prisma,
    { orgId: org.id, userId: params.actorUserId },
    { activeOnly: true },
  );
  if (!orgMember) throw new AppError('FORBIDDEN', 403);

  if (configRoleHoldsCapability(params.config, 'org', orgMember.role, 'members.manage')) {
    return { org, teamIds: null };
  }

  const memberships = await prisma.teamMember.findMany({
    where: {
      userId: params.actorUserId,
      status: 'ACTIVE',
      team: { orgId: org.id },
    },
    select: { teamId: true, teamRole: true },
  });
  const teamIds = memberships
    .filter((membership) =>
      configRoleHoldsCapability(params.config, 'team', membership.teamRole, 'members.manage'),
    )
    .map((membership) => membership.teamId)
    .sort();

  return { org, teamIds };
}

function scopeBinding(scope: InvitationScope): string {
  return scope.teamIds === null ? 'all-teams' : scope.teamIds.join(',');
}

/** Teams this actor may explicitly choose as the target of a new invitation. */
export async function listInvitationTargets(
  params: {
    orgId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    config: ClientConfig;
    limit?: number;
    cursor?: string;
    direction?: RosterDirection;
  },
  deps?: InviteDeps,
): Promise<InvitationTargetPage> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);
  const prisma = deps?.prisma ?? getPrisma();
  const scope = await resolveInvitationScope(prisma, {
    orgId: params.orgId,
    actorUserId,
    config: params.config,
  });
  if (scope.teamIds?.length === 0) {
    return {
      data: [],
      total: 0,
      meta: { hasMore: false, nextCursor: null, prevCursor: null },
      permissions: { createInvitation: false },
    };
  }

  const limit = toListLimit(params.limit);
  const direction = params.direction ?? 'forward';
  const binding = `organisation:${scope.org.id}:invitation-targets:${scopeBinding(scope)}`;
  const cursor = params.cursor
    ? decodeRosterCursor(params.cursor, env.SHARED_SECRET, binding)
    : undefined;
  const where = {
    orgId: scope.org.id,
    ...(scope.teamIds === null ? {} : { id: { in: scope.teamIds } }),
  };
  const [rows, total] = await Promise.all([
    prisma.team.findMany({
      where: { ...where, ...rosterKeysetWhere(cursor, direction) },
      orderBy: rosterOrder(direction),
      take: limit + 1,
      select: { id: true, name: true, slug: true, createdAt: true },
    }),
    prisma.team.count({ where }),
  ]);
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const displayRows = direction === 'backward' ? [...pageRows].reverse() : pageRows;
  const meta = rosterPaginationMeta({
    direction,
    rows: displayRows,
    hasMore,
    hasEarlier: Boolean(cursor),
    binding,
    secret: env.SHARED_SECRET,
  });

  return {
    data: displayRows.map((team) => ({
      id: team.id,
      name: team.name,
      slug: team.slug,
      avatarImageUrl: teamAvatarImageUrl(scope.org.domain, team.id),
    })),
    total,
    meta,
    permissions: { createInvitation: true },
  };
}

/**
 * Organisation-wide pending-invitation feed. This is intentionally distinct
 * from the owner-only member-invite approval queue: it lists actionable
 * `TeamInvite` records, including the explicit team target for every row.
 */
export async function listPendingInvitations(
  params: {
    orgId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    config: ClientConfig;
    /** Restricts this shared feed to one exact team for the team Members page. */
    teamId?: string;
    limit?: number;
    cursor?: string;
    direction?: RosterDirection;
  },
  deps?: InviteDeps,
): Promise<PendingInvitationPage> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);
  const prisma = deps?.prisma ?? getPrisma();
  const scope = await resolveInvitationScope(prisma, {
    orgId: params.orgId,
    actorUserId,
    config: params.config,
  });
  const requestedTeamId = params.teamId?.trim();
  if (
    requestedTeamId &&
    scope.teamIds !== null &&
    !scope.teamIds.includes(requestedTeamId)
  ) {
    return {
      data: [],
      total: 0,
      meta: { hasMore: false, nextCursor: null, prevCursor: null },
      permissions: { createInvitation: false, viewPendingInvitations: false },
    };
  }
  if (scope.teamIds?.length === 0) {
    return {
      data: [],
      total: 0,
      meta: { hasMore: false, nextCursor: null, prevCursor: null },
      permissions: { createInvitation: false, viewPendingInvitations: false },
    };
  }

  const limit = toListLimit(params.limit);
  const direction = params.direction ?? 'forward';
  if (requestedTeamId) {
    const exists = await prisma.team.findFirst({
      where: { id: requestedTeamId, orgId: scope.org.id },
      select: { id: true },
    });
    if (!exists) throw new AppError('NOT_FOUND', 404);
  }
  const binding = `organisation:${scope.org.id}:pending-invitations:${scopeBinding(scope)}:${requestedTeamId ?? 'all'}`;
  const cursor = params.cursor
    ? decodeRosterCursor(params.cursor, env.SHARED_SECRET, binding)
    : undefined;
  const where = {
    ...ACTIONABLE_TEAM_INVITE_WHERE,
    orgId: scope.org.id,
    ...(requestedTeamId
      ? { teamId: requestedTeamId }
      : scope.teamIds === null
        ? {}
        : { teamId: { in: scope.teamIds } }),
  };
  const [rows, total] = await Promise.all([
    prisma.teamInvite.findMany({
      where: { ...where, ...rosterKeysetWhere(cursor, direction) },
      orderBy: rosterOrder(direction),
      take: limit + 1,
      select: {
        ...TEAM_INVITE_SELECT,
        team: { select: { id: true, name: true, slug: true } },
      },
    }),
    prisma.teamInvite.count({ where }),
  ]);
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const displayRows = direction === 'backward' ? [...pageRows].reverse() : pageRows;
  const meta = rosterPaginationMeta({
    direction,
    rows: displayRows,
    hasMore,
    hasEarlier: Boolean(cursor),
    binding,
    secret: env.SHARED_SECRET,
  });
  const now = deps?.now ? deps.now() : new Date();

  return {
    data: displayRows.map((row) => ({
      ...toInviteRecord(row, now, scope.org.domain),
      team: {
        id: row.team.id,
        name: row.team.name,
        slug: row.team.slug,
        avatarImageUrl: teamAvatarImageUrl(scope.org.domain, row.team.id),
      },
    })),
    total,
    meta,
    permissions: { createInvitation: true, viewPendingInvitations: true },
  };
}
