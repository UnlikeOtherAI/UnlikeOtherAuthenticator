import type { MembershipStatus } from '@prisma/client';

import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getAdminPrisma, getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import {
  revokeRefreshTokenFamiliesForUserOrganisation,
  revokeRefreshTokensForUserDomain,
} from './refresh-token-revocation.service.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';
import { lockWorkspaceMembershipRows } from './workspace-scope.service.js';

import {
  assertDatabaseEnabled,
  auditOrg,
  ensureOrgRole,
  getOrganisationMember,
  parseOrgFeatureRoles,
  parseOrgLimit,
  resolveOrganisationByDomain,
  toListLimit,
  toMemberRecord,
  toOrganisationRecord,
  type CursorList,
  type OrgServiceDeps,
  type OrgServicePrisma,
  type OrganisationMemberRecord,
  type OrganisationRecord,
} from './organisation.service.base.js';

const MEMBER_SELECT = {
  id: true,
  orgId: true,
  userId: true,
  role: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function listOrganisationMembers(
  params: {
    orgId: string;
    domain: string;
    limit?: number;
    cursor?: string;
    status?: MembershipStatus | 'all';
  },
  deps?: OrgServiceDeps,
): Promise<CursorList<OrganisationMemberRecord>> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, params);

  const limit = toListLimit(params.limit);
  const cursor = params.cursor?.trim();
  const status = params.status ?? 'ACTIVE';
  const rows = await prisma.orgMember.findMany({
    where: { orgId: org.id, ...(status === 'all' ? {} : { status }) },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
    select: MEMBER_SELECT,
  });

  const data = rows.slice(0, limit).map(toMemberRecord);
  const nextCursorRow = rows[limit];
  return { data, next_cursor: nextCursorRow ? nextCursorRow.id : null };
}

export async function addOrganisationMember(
  params: {
    orgId: string;
    domain: string;
    actorUserId: string;
    userId: string;
    role: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<OrganisationMemberRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  const userId = params.userId.trim();
  const role = params.role.trim();
  if (!actorUserId || !userId) throw new AppError('BAD_REQUEST', 400);

  const maxMembers = parseOrgLimit(params.config);
  const orgRoles = parseOrgFeatureRoles(params.config);
  ensureOrgRole(role, orgRoles);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, params);

  const actorMembership = await getOrganisationMember(prisma, { orgId: org.id, userId: actorUserId }, { activeOnly: true });
  if (!actorMembership || (actorMembership.role !== 'owner' && actorMembership.role !== 'admin')) {
    throw new AppError('FORBIDDEN', 403);
  }
  // Only owners may grant the `owner` role. An `admin` actor must not be able to
  // self-elevate by adding another `owner` row.
  if (role === 'owner' && actorMembership.role !== 'owner') {
    throw new AppError('FORBIDDEN', 403);
  }

  const { member: createdMember, reactivated } = await runInTransaction(prisma, async (tx) => {
    await lockWorkspaceMembershipRows({ userId, orgId: org.id }, { prisma: tx });
    // Include the status so a prior DEACTIVATED/REMOVED row can be reactivated instead of
    // rejected (design §4.1: statuses are tombstones, re-adding flips them back to ACTIVE).
    const existingMemberInOrg = await tx.orgMember.findFirst({
      where: { orgId: org.id, userId },
      select: { id: true, status: true },
    });
    if (existingMemberInOrg && existingMemberInOrg.status === 'ACTIVE') {
      throw new AppError('BAD_REQUEST', 400);
    }

    // A REMOVED/DEACTIVATED membership elsewhere on the domain must not block re-adding this
    // org's own (possibly reactivated) row — only an ACTIVE membership elsewhere violates the
    // one-org-per-domain invariant.
    const existingMemberInDomain = await tx.orgMember.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        org: { domain: org.domain },
      },
      select: { id: true },
    });
    if (existingMemberInDomain) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const memberCount = await tx.orgMember.count({ where: { orgId: org.id, status: 'ACTIVE' } });
    if (memberCount >= maxMembers) throw new AppError('BAD_REQUEST', 400);

    const targetUser = await tx.user.findUnique({ where: { id: userId }, select: { id: true, domain: true } });
    if (!targetUser) throw new AppError('BAD_REQUEST', 400);
    if (targetUser.domain && targetUser.domain !== org.domain) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const defaultTeam = await tx.team.findFirst({
      where: { orgId: org.id, isDefault: true },
      select: { id: true },
    });
    if (!defaultTeam) {
      throw new AppError('INTERNAL', 500, 'DEFAULT_TEAM_MISSING');
    }

    if (existingMemberInOrg) {
      const now = new Date();
      const reactivatedMember = await tx.orgMember.update({
        where: { id: existingMemberInOrg.id },
        data: { role, status: 'ACTIVE', statusChangedAt: now },
        select: MEMBER_SELECT,
      });

      const existingTeamMembership = await tx.teamMember.findFirst({
        where: { teamId: defaultTeam.id, userId },
        select: { id: true },
      });
      if (existingTeamMembership) {
        await tx.teamMember.update({
          where: { id: existingTeamMembership.id },
          data: { status: 'ACTIVE', statusChangedAt: now },
        });
      } else {
        await tx.teamMember.create({
          data: { teamId: defaultTeam.id, userId },
        });
      }

      return { member: reactivatedMember, reactivated: true };
    }

    const created = await tx.orgMember.create({
      data: {
        orgId: org.id,
        userId,
        role,
      },
      select: MEMBER_SELECT,
    });

    await tx.teamMember.create({
      data: { teamId: defaultTeam.id, userId },
    });

    return { member: created, reactivated: false };
  });

  await auditOrg({
    orgId: org.id,
    actorUserId,
    action: 'member.added',
    targetType: 'org_member',
    targetId: createdMember.id,
    metadata: reactivated ? { userId, role, reactivated: true } : { userId, role },
  });

  return toMemberRecord(createdMember);
}

export async function changeOrganisationMemberRole(
  params: {
    orgId: string;
    domain: string;
    actorUserId: string;
    userId: string;
    role: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<OrganisationMemberRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  const userId = params.userId.trim();
  const role = params.role.trim();
  if (!actorUserId || !userId) throw new AppError('BAD_REQUEST', 400);

  const orgRoles = parseOrgFeatureRoles(params.config);
  ensureOrgRole(role, orgRoles);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, params);
  if (org.ownerId !== actorUserId) throw new AppError('FORBIDDEN', 403);

  // A non-ACTIVE (DEACTIVATED/REMOVED) member has no role to change (design §4.9: membership
  // checks require ACTIVE).
  const member = await prisma.orgMember.findFirst({
    where: { orgId: org.id, userId, status: 'ACTIVE' },
    select: { id: true, orgId: true, userId: true, role: true },
  });
  if (!member) throw new AppError('NOT_FOUND', 404);
  if (member.userId === org.ownerId && role !== 'owner') {
    throw new AppError('BAD_REQUEST', 400);
  }

  const previousRole = member.role;
  const updated = await prisma.orgMember.update({
    where: { id: member.id },
    data: { role },
    select: MEMBER_SELECT,
  });

  await auditOrg({
    orgId: org.id,
    actorUserId,
    action: 'member.role_changed',
    targetType: 'org_member',
    targetId: updated.id,
    metadata: { userId, role, previousRole },
  });

  return toMemberRecord(updated);
}

export async function removeOrganisationMember(
  params: {
    orgId: string;
    domain: string;
    actorUserId: string;
    userId: string;
  },
  deps?: OrgServiceDeps & {
    afterMembershipStatusWrite?: () => Promise<void>;
    revokeRefreshTokenFamiliesForUserOrganisation?:
      typeof revokeRefreshTokenFamiliesForUserOrganisation;
    revokeRefreshTokensForUserDomain?: typeof revokeRefreshTokensForUserDomain;
  },
): Promise<{ removed: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  const userId = params.userId.trim();
  if (!actorUserId || !userId) throw new AppError('BAD_REQUEST', 400);

  // This destructive lifecycle boundary must revoke scoped sessions issued by every product
  // domain in the same transaction, which requires the BYPASSRLS client.
  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, params);

  const actorMembership = await getOrganisationMember(prisma, { orgId: org.id, userId: actorUserId }, { activeOnly: true });
  if (!actorMembership || (actorMembership.role !== 'owner' && actorMembership.role !== 'admin')) {
    throw new AppError('FORBIDDEN', 403);
  }

  const member = await getOrganisationMember(prisma, { orgId: org.id, userId });
  if (!member) throw new AppError('NOT_FOUND', 404);

  // Only owners may remove another `owner` member. An `admin` actor cannot remove
  // an owner even when other owners remain.
  if (member.role === 'owner' && actorMembership.role !== 'owner') {
    throw new AppError('FORBIDDEN', 403);
  }

  // Owner-count guards must count ACTIVE owners only (design §4.1/§4.5) — a REMOVED/DEACTIVATED
  // owner row must not be able to block the last remaining active owner from being removed, nor
  // count toward "there is still another owner".
  const ownerCount = await prisma.orgMember.count({
    where: { orgId: org.id, role: 'owner', status: 'ACTIVE' },
  });
  if (member.role === 'owner' && ownerCount <= 1) {
    throw new AppError('BAD_REQUEST', 400);
  }

  await runInTransaction(prisma, async (tx) => {
    await lockRefreshSessionUserDomain({ userId, domain: org.domain }, { prisma: tx });
    await lockWorkspaceMembershipRows({ userId, orgId: org.id }, { prisma: tx });
    const lockedMember = await tx.orgMember.findFirst({
      where: { orgId: org.id, userId },
      select: { id: true, role: true, userId: true },
    });
    if (!lockedMember) throw new AppError('NOT_FOUND', 404);

    const ownerCountTx = await tx.orgMember.count({
      where: { orgId: org.id, role: 'owner', status: 'ACTIVE' },
    });
    if (lockedMember.role === 'owner' && ownerCountTx <= 1) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const owners = lockedMember.userId === org.ownerId
      ? await tx.orgMember.findMany({
          where: {
            orgId: org.id,
            role: 'owner',
            status: 'ACTIVE',
            userId: { not: lockedMember.userId },
          },
          select: { userId: true },
        })
      : [];

    if (lockedMember.userId === org.ownerId && owners.length) {
      await tx.organisation.update({
        where: { id: org.id },
        data: { ownerId: owners[0].userId },
      });
    }

    const now = new Date();

    await tx.teamMember.updateMany({
      where: {
        userId,
        team: {
          orgId: org.id,
        },
        status: { not: 'REMOVED' },
      },
      data: { status: 'REMOVED', statusChangedAt: now },
    });
    // Groups have no status column (no lifecycle tombstone for group membership) — hard delete
    // remains correct here.
    await tx.groupMember.deleteMany({
      where: {
        userId,
        group: {
          orgId: org.id,
        },
      },
    });
    await tx.orgMember.update({
      where: { id: lockedMember.id },
      data: { status: 'REMOVED', statusChangedAt: now },
    });
    await deps?.afterMembershipStatusWrite?.();

    const revokeDeps = { now: () => now, prisma: tx };
    await (
      deps?.revokeRefreshTokenFamiliesForUserOrganisation ??
      revokeRefreshTokenFamiliesForUserOrganisation
    )(userId, org.id, revokeDeps);
    await (deps?.revokeRefreshTokensForUserDomain ?? revokeRefreshTokensForUserDomain)(
      userId,
      org.domain,
      revokeDeps,
    );
  });

  await auditOrg({
    orgId: org.id,
    actorUserId,
    action: 'member.removed',
    targetType: 'org_member',
    targetId: member.id,
    metadata: { userId, role: member.role },
  });

  return { removed: true };
}

export async function transferOrganisationOwnership(
  params: {
    orgId: string;
    domain: string;
    actorUserId: string;
    newOwnerId: string;
  },
  deps?: OrgServiceDeps,
): Promise<OrganisationRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  const newOwnerId = params.newOwnerId.trim();
  if (!actorUserId || !newOwnerId) throw new AppError('BAD_REQUEST', 400);
  if (actorUserId === newOwnerId) throw new AppError('BAD_REQUEST', 400);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, params);
  if (org.ownerId !== actorUserId) {
    throw new AppError('FORBIDDEN', 403);
  }

  const newOwnerMembership = await getOrganisationMember(prisma, { orgId: org.id, userId: newOwnerId });
  if (!newOwnerMembership) throw new AppError('NOT_FOUND', 404);

  const updated = await runInTransaction(prisma, async (tx) => {
    await tx.organisation.update({
      where: { id: org.id },
      data: { ownerId: newOwnerId },
    });

    await tx.orgMember.update({
      where: { id: newOwnerMembership.id },
      data: { role: 'owner' },
    });

    const oldOwnerMembership = await tx.orgMember.findFirst({
      where: { orgId: org.id, userId: actorUserId },
      select: { id: true },
    });
    if (oldOwnerMembership) {
      await tx.orgMember.update({
        where: { id: oldOwnerMembership.id },
        data: { role: 'admin' },
      });
    }

    return await tx.organisation.findUniqueOrThrow({
      where: { id: org.id },
      select: {
        id: true,
        domain: true,
        name: true,
        slug: true,
        ownerId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  return toOrganisationRecord(updated);
}
