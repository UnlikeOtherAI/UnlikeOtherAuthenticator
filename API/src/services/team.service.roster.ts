import type { MembershipStatus } from '@prisma/client';

import type { ClientConfig } from './config.service.js';
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
  getEnv,
  getPrisma,
  hasTeamCapability,
  memberAvatarImageUrl,
  requireTeamCapability,
  resolveAndAuthorizeTeamOrg,
  resolveOrgActor,
  toListLimit,
  type OrgActorProvenance,
  type OrgServiceDeps,
  type OrgServicePrisma,
} from './team.service.base.js';

const TEAM_ROSTER_SELECT = {
  id: true,
  teamId: true,
  userId: true,
  teamRole: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
} as const;

export type TeamRosterMember = {
  id: string;
  teamId: string;
  /** Legacy alias for `subject`. */
  userId: string;
  /** Stable UOA subject. */
  subject: string;
  avatarImageUrl: string;
  identity: {
    displayName: string | null;
    avatarImageUrl: string;
    /** Team managers alone receive a member's email address. */
    email?: string;
  };
  /** Canonical roster role; `teamRole` remains for existing consumers. */
  role: string;
  teamRole: string;
  status: MembershipStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type TeamRosterPermissions = {
  addMember: boolean;
  changeMemberRole: boolean;
  removeMember: boolean;
  viewMemberEmail: boolean;
  searchMemberCandidates: boolean;
};

export type TeamRosterPage = {
  data: TeamRosterMember[];
  total: number;
  meta: RosterPaginationMeta;
  /** Legacy-compatible continuation alias for `meta.nextCursor`. */
  next_cursor: string | null;
  permissions: TeamRosterPermissions;
};

export type TeamMemberCandidate = {
  subject: string;
  userId: string;
  orgRole: string;
  avatarImageUrl: string;
  identity: {
    displayName: string | null;
    avatarImageUrl: string;
    email: string;
  };
};

export type TeamMemberCandidatePage = {
  data: TeamMemberCandidate[];
  total: number;
  meta: RosterPaginationMeta;
  permissions: Pick<TeamRosterPermissions, 'addMember' | 'searchMemberCandidates'>;
};

function toTeamRosterMember(
  row: {
    id: string;
    teamId: string;
    userId: string;
    teamRole: string;
    status: MembershipStatus;
    createdAt: Date;
    updatedAt: Date;
    user: { id: string; name: string | null; email: string };
  },
  domain: string,
  includeEmail: boolean,
): TeamRosterMember {
  const avatarImageUrl = memberAvatarImageUrl(domain, row.user.id);
  return {
    id: row.id,
    teamId: row.teamId,
    userId: row.user.id,
    subject: row.user.id,
    avatarImageUrl,
    identity: {
      displayName: row.user.name,
      avatarImageUrl,
      ...(includeEmail ? { email: row.user.email } : {}),
    },
    role: row.teamRole,
    teamRole: row.teamRole,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function resolveTeamRosterAccess(
  prisma: OrgServicePrisma,
  params: {
    orgId: string;
    teamId: string;
    actorUserId: string | undefined;
    config: ClientConfig;
  },
) {
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    actorUserId: params.actorUserId,
  });
  const team = await prisma.team.findFirst({
    where: { id: params.teamId, orgId: org.id },
    select: { id: true },
  });
  if (!team) throw new AppError('NOT_FOUND', 404);

  return { org, team };
}

async function teamRosterPermissions(
  prisma: OrgServicePrisma,
  params: { orgId: string; teamId: string; actorUserId: string | undefined; config: ClientConfig },
): Promise<TeamRosterPermissions> {
  // Backend mode is intentionally true here: the domain pairing is the actor and
  // retains the same full authority that existing team mutation routes have.
  if (!params.actorUserId) {
    return {
      addMember: true,
      changeMemberRole: true,
      removeMember: true,
      viewMemberEmail: true,
      searchMemberCandidates: true,
    };
  }

  const canManage = await hasTeamCapability(prisma, 'members.manage', params);
  return {
    addMember: canManage,
    changeMemberRole: canManage,
    removeMember: canManage,
    viewMemberEmail: canManage,
    searchMemberCandidates: canManage,
  };
}

/** A paged team roster that retains lifecycle tombstones when requested. */
export async function listTeamMembers(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    config: ClientConfig;
    limit?: number;
    cursor?: string;
    direction?: RosterDirection;
    status?: MembershipStatus | 'all';
  },
  deps?: OrgServiceDeps,
): Promise<TeamRosterPage> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);
  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const { org, team } = await resolveTeamRosterAccess(prisma, {
    orgId: params.orgId,
    teamId: params.teamId,
    actorUserId,
    config: params.config,
  });
  const permissions = await teamRosterPermissions(prisma, {
    orgId: org.id,
    teamId: team.id,
    actorUserId,
    config: params.config,
  });

  const limit = toListLimit(params.limit);
  const direction = params.direction ?? 'forward';
  const status = params.status ?? 'ACTIVE';
  const binding = `team:${team.id}:status:${status}`;
  const cursor = params.cursor
    ? decodeRosterCursor(params.cursor, env.SHARED_SECRET, binding)
    : undefined;
  const statusWhere = status === 'all' ? {} : { status };
  const [rows, total] = await Promise.all([
    prisma.teamMember.findMany({
      where: { teamId: team.id, ...statusWhere, ...rosterKeysetWhere(cursor, direction) },
      orderBy: rosterOrder(direction),
      take: limit + 1,
      select: TEAM_ROSTER_SELECT,
    }),
    prisma.teamMember.count({ where: { teamId: team.id, ...statusWhere } }),
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
    data: displayRows.map((row) =>
      toTeamRosterMember(row, org.domain, permissions.viewMemberEmail),
    ),
    total,
    meta,
    next_cursor: meta.nextCursor,
    permissions,
  };
}

/**
 * Manager-only, bounded team-add candidate search. The organisation-membership
 * table is the query root: this cannot become a domain-wide user lookup.
 */
export async function findTeamMemberCandidates(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    config: ClientConfig;
    q: string;
    limit?: number;
    cursor?: string;
    direction?: RosterDirection;
  },
  deps?: OrgServiceDeps,
): Promise<TeamMemberCandidatePage> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const query = params.q.trim();
  if (!query || query.length > 100) throw new AppError('BAD_REQUEST', 400);
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? 20), 1), 50);
  const actorUserId = resolveOrgActor(params);
  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const { org, team } = await resolveTeamRosterAccess(prisma, {
    orgId: params.orgId,
    teamId: params.teamId,
    actorUserId,
    config: params.config,
  });
  await requireTeamCapability(prisma, 'members.manage', {
    orgId: org.id,
    teamId: team.id,
    actorUserId,
    config: params.config,
  });

  const binding = `team:${team.id}:candidates:${query.toLowerCase()}`;
  const direction = params.direction ?? 'forward';
  const cursor = params.cursor
    ? decodeRosterCursor(params.cursor, env.SHARED_SECRET, binding)
    : undefined;
  const candidateWhere = {
    orgId: org.id,
    status: 'ACTIVE' as const,
    user: {
      AND: [
        {
          OR: [
            { name: { contains: query, mode: 'insensitive' as const } },
            { email: { contains: query, mode: 'insensitive' as const } },
          ],
        },
        { teamMembers: { none: { teamId: team.id, status: 'ACTIVE' as const } } },
      ],
    },
  };
  const [rows, total] = await Promise.all([
    prisma.orgMember.findMany({
      where: { ...candidateWhere, ...rosterKeysetWhere(cursor, direction) },
      orderBy: rosterOrder(direction),
      take: limit + 1,
      select: {
        id: true,
        createdAt: true,
        userId: true,
        role: true,
        user: { select: { id: true, name: true, email: true } },
      },
    }),
    // `total` is the total matching the search, not only the rows after this
    // cursor. Applying the keyset clause here would make it shrink on page two.
    prisma.orgMember.count({ where: candidateWhere }),
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
    data: displayRows.map((row) => {
      const avatarImageUrl = memberAvatarImageUrl(org.domain, row.user.id);
      return {
        subject: row.user.id,
        userId: row.user.id,
        orgRole: row.role,
        avatarImageUrl,
        identity: { displayName: row.user.name, avatarImageUrl, email: row.user.email },
      };
    }),
    total,
    meta,
    permissions: { addMember: true, searchMemberCandidates: true },
  };
}
