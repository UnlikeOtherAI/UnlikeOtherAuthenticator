import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getAdminPrisma, getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';

import { auditOrg } from './organisation.service.base.js';
import { revokeRefreshTokenFamiliesForUserTeam } from './refresh-token-revocation.service.js';
import { lockRefreshSessionUser } from './refresh-session-lock.service.js';
import { lockWorkspaceMembershipRows } from './workspace-scope.service.js';
import {
  assertDatabaseEnabled,
  getOrganisationMember,
  normalizeTeamRole,
  parseMaxMembersPerTeam,
  parseMaxTeamMembershipsPerUser,
  requireTeamManager,
  resolveAndAuthorizeTeamOrg,
  toTeamMemberRecord,
  type OrgServiceDeps,
  type OrgServicePrisma,
  type TeamMemberRecord,
  isP2002Error,
} from './team.service.base.js';

export async function addTeamMember(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId: string;
    userId: string;
    teamRole?: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<TeamMemberRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  const userId = params.userId.trim();
  const teamRole = normalizeTeamRole(params.teamRole);
  const maxMembersPerTeam = parseMaxMembersPerTeam(params.config);
  const maxTeamMembershipsPerUser = parseMaxTeamMembershipsPerUser(params.config);

  if (!actorUserId || !userId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    domain: params.domain,
    actorUserId,
  });
  await requireTeamManager(prisma, org.id, actorUserId);

  const target = await getOrganisationMember(prisma, {
    orgId: org.id,
    userId,
  });
  if (!target) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const team = await prisma.team.findFirst({
    where: {
      id: params.teamId,
      orgId: org.id,
    },
    select: { id: true },
  });
  if (!team) {
    throw new AppError('NOT_FOUND', 404);
  }

  return await runInTransaction(prisma, async (tx) => {
    await lockWorkspaceMembershipRows(
      { userId, orgId: org.id, teamId: team.id },
      { prisma: tx },
    );
    const memberCount = await tx.teamMember.count({
      where: { teamId: team.id, status: 'ACTIVE' },
    });
    if (memberCount >= maxMembersPerTeam) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const userMemberships = await tx.teamMember.count({
      where: {
        userId,
        team: {
          orgId: org.id,
        },
        status: 'ACTIVE',
      },
    });
    if (userMemberships >= maxTeamMembershipsPerUser) {
      throw new AppError('BAD_REQUEST', 400);
    }

    // A prior DEACTIVATED/REMOVED (teamId, userId) row is reactivated instead of rejected
    // (design §4.1: statuses are tombstones under the same unique constraint).
    const existing = await tx.teamMember.findFirst({
      where: { teamId: team.id, userId },
      select: { id: true, status: true },
    });
    if (existing && existing.status === 'ACTIVE') {
      throw new AppError('BAD_REQUEST', 400);
    }

    try {
      const record = existing
        ? await tx.teamMember.update({
            where: { id: existing.id },
            data: { teamRole, status: 'ACTIVE', statusChangedAt: new Date() },
            select: {
              id: true,
              teamId: true,
              userId: true,
              teamRole: true,
              createdAt: true,
              updatedAt: true,
            },
          })
        : await tx.teamMember.create({
            data: {
              teamId: team.id,
              userId,
              teamRole,
            },
            select: {
              id: true,
              teamId: true,
              userId: true,
              teamRole: true,
              createdAt: true,
              updatedAt: true,
            },
          });

      return toTeamMemberRecord(record);
    } catch (err) {
      if (isP2002Error(err)) {
        throw new AppError('BAD_REQUEST', 400);
      }
      throw err;
    }
  });
}

export async function changeTeamMemberRole(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId: string;
    userId: string;
    teamRole: string;
  },
  deps?: OrgServiceDeps,
): Promise<TeamMemberRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  const userId = params.userId.trim();
  const teamRole = normalizeTeamRole(params.teamRole);

  if (!actorUserId || !userId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    domain: params.domain,
    actorUserId,
  });
  await requireTeamManager(prisma, org.id, actorUserId);

  const team = await prisma.team.findFirst({
    where: {
      id: params.teamId,
      orgId: org.id,
    },
    select: { id: true },
  });
  if (!team) {
    throw new AppError('NOT_FOUND', 404);
  }

  // A non-ACTIVE (DEACTIVATED/REMOVED) team member has no role to change.
  const member = await prisma.teamMember.findFirst({
    where: {
      teamId: team.id,
      userId,
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  if (!member) {
    throw new AppError('NOT_FOUND', 404);
  }

  const updated = await prisma.teamMember.update({
    where: { id: member.id },
    data: { teamRole },
    select: {
      id: true,
      teamId: true,
      userId: true,
      teamRole: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return toTeamMemberRecord(updated);
}

export async function removeTeamMember(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId: string;
    userId: string;
  },
  deps?: OrgServiceDeps & {
    afterMembershipStatusWrite?: () => Promise<void>;
    revokeRefreshTokenFamiliesForUserTeam?: typeof revokeRefreshTokenFamiliesForUserTeam;
  },
): Promise<{ removed: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  const userId = params.userId.trim();

  if (!actorUserId || !userId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  // Team-scoped sessions may have been issued by any recognized product domain. Keep the
  // membership tombstone and exact-team revocation in one BYPASSRLS transaction.
  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    domain: params.domain,
    actorUserId,
  });
  await requireTeamManager(prisma, org.id, actorUserId);

  const team = await prisma.team.findFirst({
    where: {
      id: params.teamId,
      orgId: org.id,
    },
    select: { id: true },
  });
  if (!team) {
    throw new AppError('NOT_FOUND', 404);
  }

  return await runInTransaction(prisma, async (tx) => {
    await lockRefreshSessionUser(userId, { prisma: tx });
    await lockWorkspaceMembershipRows(
      { userId, orgId: org.id },
      { prisma: tx },
    );
    const lockedMembership = await tx.teamMember.findFirst({
      where: {
        teamId: team.id,
        userId,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    if (!lockedMembership) {
      throw new AppError('NOT_FOUND', 404);
    }

    // "Cannot leave your last team" counts ACTIVE team memberships only (design §4.5).
    const userTeamCount = await tx.teamMember.count({
      where: {
        userId,
        team: {
          orgId: org.id,
        },
        status: 'ACTIVE',
      },
    });

    if (userTeamCount <= 1) {
      throw new AppError('BAD_REQUEST', 400);
    }

    // Team removal is a tombstone, not a delete (design §4.5). Organisation identity remains
    // active, while only refresh families carrying this exact team scope are revoked.
    const now = new Date();
    await tx.teamMember.update({
      where: { id: lockedMembership.id },
      data: { status: 'REMOVED', statusChangedAt: now },
    });
    await deps?.afterMembershipStatusWrite?.();
    await (
      deps?.revokeRefreshTokenFamiliesForUserTeam ?? revokeRefreshTokenFamiliesForUserTeam
    )(userId, team.id, { now: () => now, prisma: tx });

    return { removed: true };
  });
}

/**
 * Self-join (Phase 4, design §4.6): `POST /org/organisations/:orgId/teams/:teamId/join`. Allowed
 * only when the team's `joinPolicy` is `OPEN_TO_ORG` and the caller is an ACTIVE member of the
 * team's org (`resolveAndAuthorizeTeamOrg` already enforces the latter). Reactivates a prior
 * REMOVED/DEACTIVATED row instead of rejecting it as a duplicate (design §4.1), same as the
 * owner/admin `addTeamMember` path. Every rejection is the same generic error — no oracle on why
 * self-join failed (team not found vs. wrong policy vs. already a member all look identical).
 */
export async function selfJoinTeam(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<TeamMemberRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  if (!actorUserId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const maxMembersPerTeam = parseMaxMembersPerTeam(params.config);
  const maxTeamMembershipsPerUser = parseMaxTeamMembershipsPerUser(params.config);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    domain: params.domain,
    actorUserId,
  });

  const team = await prisma.team.findFirst({
    where: { id: params.teamId, orgId: org.id },
    select: { id: true, joinPolicy: true },
  });
  if (!team || team.joinPolicy !== 'OPEN_TO_ORG') {
    throw new AppError('BAD_REQUEST', 400);
  }

  const record = await runInTransaction(prisma, async (tx) => {
    await lockWorkspaceMembershipRows(
      { userId: actorUserId, orgId: org.id, teamId: team.id },
      { prisma: tx },
    );
    const memberCount = await tx.teamMember.count({
      where: { teamId: team.id, status: 'ACTIVE' },
    });
    if (memberCount >= maxMembersPerTeam) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const userMemberships = await tx.teamMember.count({
      where: { userId: actorUserId, team: { orgId: org.id }, status: 'ACTIVE' },
    });
    if (userMemberships >= maxTeamMembershipsPerUser) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const existing = await tx.teamMember.findFirst({
      where: { teamId: team.id, userId: actorUserId },
      select: { id: true, status: true },
    });
    if (existing && existing.status === 'ACTIVE') {
      throw new AppError('BAD_REQUEST', 400);
    }

    try {
      return existing
        ? await tx.teamMember.update({
            where: { id: existing.id },
            data: { status: 'ACTIVE', statusChangedAt: new Date() },
            select: {
              id: true,
              teamId: true,
              userId: true,
              teamRole: true,
              createdAt: true,
              updatedAt: true,
            },
          })
        : await tx.teamMember.create({
            data: { teamId: team.id, userId: actorUserId },
            select: {
              id: true,
              teamId: true,
              userId: true,
              teamRole: true,
              createdAt: true,
              updatedAt: true,
            },
          });
    } catch (err) {
      if (isP2002Error(err)) {
        throw new AppError('BAD_REQUEST', 400);
      }
      throw err;
    }
  });

  await auditOrg({
    orgId: org.id,
    actorUserId,
    action: 'team_member.added',
    targetType: 'team_member',
    targetId: record.id,
    metadata: { teamId: team.id, via: 'self_join' },
  });

  return toTeamMemberRecord(record);
}
