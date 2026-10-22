import { teamTelephoneNumbers } from './telephone-directory.service.js';
import type { MembershipStatus } from '@prisma/client';
import { createHash } from 'node:crypto';

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
import { resolveTeamRoleVocabulary } from './role-grants.js';

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
    /** Verified number opted into sharing with active colleagues in this team. */
    telephoneNumber?: string;
    /** Team managers alone receive a member's email address. */
    email?: string;
  };
  /** Canonical roster role; `teamRole` remains for existing consumers. */
  role: string;
  teamRole: string;
  /** Current active membership in this exact organisation; null after withdrawal. */
  orgRole: string | null;
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
  /** Roles a roster manager may assign. Ownership stays a separate operation. */
  teamRoleOptions: string[];
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
    email: string | null;
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
    user: { id: string; name: string | null; email: string | null };
  },
  domain: string,
  includeEmail: boolean,
  orgRole: string | null,
  telephoneNumber?: string,
): TeamRosterMember {
  const avatarImageUrl = memberAvatarImageUrl(domain, row.user.id);
  return {
    id: row.id,
    teamId: row.teamId,
    userId: row.user.id,
    subject: row.user.id,
    avatarImageUrl,
    identity: {
      ...(telephoneNumber ? { telephoneNumber } : {}),
      displayName: row.user.name,
      avatarImageUrl,
      ...(includeEmail && row.user.email ? { email: row.user.email } : {}),
    },
    role: row.teamRole,
    teamRole: row.teamRole,
    orgRole,
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
  const teamRoleOptions = resolveTeamRoleVocabulary(params.config).filter((role) => role !== 'owner');
  // Backend mode is intentionally true here: the domain pairing is the actor and
  // retains the same full authority that existing team mutation routes have.
  if (!params.actorUserId) {
    return {
      addMember: true,
      changeMemberRole: true,
      removeMember: true,
      viewMemberEmail: true,
      searchMemberCandidates: true,
      teamRoleOptions,
    };
  }

  const canManage = await hasTeamCapability(prisma, 'members.manage', params);
  return {
    addMember: canManage,
    changeMemberRole: canManage,
    removeMember: canManage,
    viewMemberEmail: canManage,
    searchMemberCandidates: canManage,
    teamRoleOptions: canManage ? teamRoleOptions : [],
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
    subjectIds?: string[];
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
  if (params.subjectIds && (params.subjectIds.length > 100 || params.subjectIds.some((id) => !id || id.length > 256))) {
    throw new AppError('BAD_REQUEST', 400, 'ROSTER_SUBJECT_FILTER_INVALID');
  }
  const subjectIds = params.subjectIds ? [...new Set(params.subjectIds)].sort() : undefined;
  const subjectBinding = subjectIds ? `:subjects:${createHash('sha256').update(JSON.stringify(subjectIds)).digest('hex')}` : '';
  const binding = `team:${team.id}:status:${status}${subjectBinding}`;
  const cursor = params.cursor
    ? decodeRosterCursor(params.cursor, env.SHARED_SECRET, binding)
    : undefined;
  const statusWhere = status === 'all' ? {} : { status };
  const subjectWhere = subjectIds ? { userId: { in: subjectIds } } : {};
  const [rows, total] = await Promise.all([
    prisma.teamMember.findMany({
      where: { teamId: team.id, ...statusWhere, ...subjectWhere, ...rosterKeysetWhere(cursor, direction) },
      orderBy: rosterOrder(direction),
      take: limit + 1,
      select: TEAM_ROSTER_SELECT,
    }),
    prisma.teamMember.count({ where: { teamId: team.id, ...statusWhere, ...subjectWhere } }),
  ]);

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const displayRows = direction === 'backward' ? [...pageRows].reverse() : pageRows;
  const memberships = await prisma.orgMember.findMany({ where: { orgId: org.id, status: 'ACTIVE',
    userId: { in: displayRows.map((row) => row.userId) } }, select: { userId: true, role: true } });
  const orgRoles = new Map(memberships.map((row) => [row.userId, row.role]));
  const meta = rosterPaginationMeta({
    direction,
    rows: displayRows,
    hasMore,
    hasEarlier: Boolean(cursor),
    binding,
    secret: env.SHARED_SECRET,
  });

  const telephones = await teamTelephoneNumbers({ orgId: org.id, teamId: team.id, actorUserId,
    userIds: displayRows.filter(row => row.status === 'ACTIVE').map(row => row.userId) });
  return {
    data: displayRows.map((row) =>
      toTeamRosterMember(row, org.domain, permissions.viewMemberEmail,
        orgRoles.get(row.userId) ?? null, telephones.get(row.userId)),
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

