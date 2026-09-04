import type { MembershipStatus } from '@prisma/client';

import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
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
import { configRoleHoldsCapability } from './role-grants.js';
import {
  assertDatabaseEnabled,
  getOrganisationMember,
  memberAvatarImageUrl,
  resolveOrgActor,
  resolveOrganisation,
  toListLimit,
  type OrgActorProvenance,
  type OrgServiceDeps,
  type OrgServicePrisma,
} from './organisation.service.base.js';

const ROSTER_MEMBER_SELECT = {
  id: true,
  orgId: true,
  userId: true,
  role: true,
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

export type MemberIdentity = {
  displayName: string | null;
  avatarImageUrl: string;
  /** Present only to a caller holding the action-specific `members.manage` capability. */
  email?: string;
};

export type OrganisationRosterMember = {
  id: string;
  orgId: string;
  /** Legacy alias for `subject`. */
  userId: string;
  /** Stable UOA subject, suitable as the relying party's external user reference. */
  subject: string;
  avatarImageUrl: string;
  identity: MemberIdentity;
  role: string;
  status: MembershipStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type OrganisationRosterPermissions = {
  addMember: boolean;
  changeMemberRole: boolean;
  removeMember: boolean;
  deactivateMember: boolean;
  reactivateMember: boolean;
  viewMemberEmail: boolean;
};

export type OrganisationRosterPage = {
  data: OrganisationRosterMember[];
  total: number;
  meta: RosterPaginationMeta;
  /** Legacy continuation field; equivalent to `meta.nextCursor`. */
  next_cursor: string | null;
  permissions: OrganisationRosterPermissions;
};

function toRosterMember(
  row: {
    id: string;
    orgId: string;
    userId: string;
    role: string;
    status: MembershipStatus;
    createdAt: Date;
    updatedAt: Date;
    user: { id: string; name: string | null; email: string };
  },
  domain: string,
  includeEmail: boolean,
): OrganisationRosterMember {
  const avatarImageUrl = memberAvatarImageUrl(domain, row.user.id);
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.user.id,
    subject: row.user.id,
    avatarImageUrl,
    identity: {
      displayName: row.user.name,
      avatarImageUrl,
      ...(includeEmail ? { email: row.user.email } : {}),
    },
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rosterPermissions(params: {
  actorUserId: string | undefined;
  orgOwnerId: string;
  actorRole: string | undefined;
  config: ClientConfig;
}): OrganisationRosterPermissions {
  const canManage =
    !params.actorUserId ||
    configRoleHoldsCapability(params.config, 'org', params.actorRole, 'members.manage');
  const isOwner = !params.actorUserId || params.orgOwnerId === params.actorUserId;

  return {
    addMember: canManage,
    changeMemberRole: isOwner,
    removeMember: canManage,
    deactivateMember: canManage,
    reactivateMember: canManage,
    viewMemberEmail: canManage,
  };
}

/**
 * Stateless, keyset-paged organisation roster. Membership is the query root,
 * so its user relation can only reveal identity for a user who belongs to the
 * target organisation; this never expands into a domain-wide user directory.
 */
export async function listOrganisationMembers(
  params: {
    orgId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    config?: ClientConfig;
    limit?: number;
    cursor?: string;
    direction?: RosterDirection;
    status?: MembershipStatus | 'all';
  },
  deps?: OrgServiceDeps,
): Promise<OrganisationRosterPage> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  // The HTTP route always names either the user or the accepted backend actor.
  // Keeping an absent actor valid here preserves the old direct-service read
  // shape for trusted internal callers; it is equivalent to backend mode.
  const actorUserId =
    params.actorUserId !== undefined || params.actor !== undefined
      ? resolveOrgActor(params)
      : undefined;
  const config = params.config ?? ({} as ClientConfig);
  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisation(prisma, { orgId: params.orgId });
  const actorMembership = actorUserId
    ? await getOrganisationMember(
        prisma,
        { orgId: org.id, userId: actorUserId },
        { activeOnly: true },
      )
    : null;
  if (actorUserId && !actorMembership) throw new AppError('FORBIDDEN', 403);

  const limit = toListLimit(params.limit);
  const direction = params.direction ?? 'forward';
  const status = params.status ?? 'ACTIVE';
  const binding = `organisation:${org.id}:status:${status}`;
  const cursor = params.cursor
    ? decodeRosterCursor(params.cursor, env.SHARED_SECRET, binding)
    : undefined;
  const statusWhere = status === 'all' ? {} : { status };
  const [rows, total] = await Promise.all([
    prisma.orgMember.findMany({
      where: { orgId: org.id, ...statusWhere, ...rosterKeysetWhere(cursor, direction) },
      orderBy: rosterOrder(direction),
      take: limit + 1,
      select: ROSTER_MEMBER_SELECT,
    }),
    prisma.orgMember.count({ where: { orgId: org.id, ...statusWhere } }),
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
  const permissions = rosterPermissions({
    actorUserId,
    orgOwnerId: org.ownerId,
    actorRole: actorMembership?.role,
    config,
  });

  return {
    data: displayRows.map((row) => toRosterMember(row, org.domain, permissions.viewMemberEmail)),
    total,
    meta,
    next_cursor: meta.nextCursor,
    permissions,
  };
}
