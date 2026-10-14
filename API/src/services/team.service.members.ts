import { withDirectoryMutation } from './directory-mutation.service.js';
import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getAdminPrisma, getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { auditOrg, type OrgActorProvenance } from './organisation.service.base.js';
import { revokeRefreshTokenFamiliesForUserTeam } from './refresh-token-revocation.service.js';
import { lockRefreshSessionUser } from './refresh-session-lock.service.js';
import { lockTeamMembershipRows } from './team-scope.service.js';
import {
  assertDatabaseEnabled,
  getOrganisationMember,
  normalizeTeamRole,
  parseMaxMembersPerTeam,
  parseMaxTeamMembershipsPerUser,
  requireTeamCapability,
  resolveAndAuthorizeTeamOrg,
  resolveOrgActor,
  toTeamMemberRecord,
  type OrgServiceDeps,
  type OrgServicePrisma,
  type TeamMemberRecord,
  isP2002Error,
} from './team.service.base.js';
/**
 * Manager-driven team mutations (`addTeamMember` / `changeTeamMemberRole` / `removeTeamMember`) each
 * write an org audit row tagged with this `via`, so the audit stream distinguishes an owner/admin
 * acting on somebody else's membership from the self-service paths (`self_join`, `invite_link`).
 */
const AUDIT_VIA_MANAGER = 'manager';
export async function addTeamMember(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    userId: string;
    teamRole?: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<TeamMemberRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);
  const actorUserId = resolveOrgActor(params);
  const userId = params.userId.trim();
  const teamRole = normalizeTeamRole(params.teamRole, params.config);
  const maxMembersPerTeam = parseMaxMembersPerTeam(params.config);
  const maxTeamMembershipsPerUser = parseMaxTeamMembershipsPerUser(params.config);
  if (!userId) {
    throw new AppError('BAD_REQUEST', 400);
  }
  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    actorUserId,
  });
  await requireTeamCapability(prisma, 'members.manage', {
    orgId: org.id,
    teamId: params.teamId,
    actorUserId,
    config: params.config,
  });
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
  const { member, reactivated } = await withDirectoryMutation(
    prisma,
    [{ orgId: org.id, kind: 'membership.changed', subjectId: userId, teamId: team.id }],
    async (tx) => {
      await lockTeamMembershipRows({ userId, orgId: org.id, teamId: team.id }, { prisma: tx });
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

        return { member: record, reactivated: Boolean(existing) };
      } catch (err) {
        if (isP2002Error(err)) {
          throw new AppError('BAD_REQUEST', 400);
        }
        throw err;
      }
    },
  );

  await auditOrg({
    orgId: org.id,
    actorUserId,
    actor: params.actor,
    action: 'team_member.added',
    targetType: 'team_member',
    targetId: member.id,
    metadata: {
      teamId: team.id,
      userId,
      teamRole,
      via: AUDIT_VIA_MANAGER,
      ...(reactivated ? { reactivated: true } : {}),
    },
  });

  return toTeamMemberRecord(member, org.domain);
}

export async function changeTeamMemberRole(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    userId: string;
    teamRole: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<TeamMemberRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);
  const userId = params.userId.trim();
  const teamRole = normalizeTeamRole(params.teamRole, params.config);

  if (!userId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    actorUserId,
  });
  await requireTeamCapability(prisma, 'members.manage', {
    orgId: org.id,
    teamId: params.teamId,
    actorUserId,
    config: params.config,
  });

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
    // `teamRole` is read for the audit row's `previousTeamRole`, mirroring
    // `changeOrganisationMemberRole`'s `previousRole`.
    select: { id: true, teamRole: true },
  });
  if (!member) {
    throw new AppError('NOT_FOUND', 404);
  }

  const previousTeamRole = member.teamRole;
  const updated = await withDirectoryMutation(
    prisma,
    [{ orgId: org.id, kind: 'membership.changed', subjectId: userId, teamId: team.id }],
    (tx) =>
      tx.teamMember.update({
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
      }),
  );

  await auditOrg({
    orgId: org.id,
    actorUserId,
    actor: params.actor,
    action: 'team_member.role_changed',
    targetType: 'team_member',
    targetId: updated.id,
    metadata: {
      teamId: team.id,
      userId,
      teamRole,
      previousTeamRole,
      via: AUDIT_VIA_MANAGER,
    },
  });

  return toTeamMemberRecord(updated, org.domain);
}

export async function removeTeamMember(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    userId: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps & {
    afterMembershipStatusWrite?: () => Promise<void>;
    revokeRefreshTokenFamiliesForUserTeam?: typeof revokeRefreshTokenFamiliesForUserTeam;
  },
): Promise<{ removed: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);
  const userId = params.userId.trim();

  if (!userId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  // Team-scoped sessions may have been issued by any recognized product domain. Keep the
  // membership tombstone and exact-team revocation in one BYPASSRLS transaction.
  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    actorUserId,
  });
  await requireTeamCapability(prisma, 'members.manage', {
    orgId: org.id,
    teamId: params.teamId,
    actorUserId,
    config: params.config,
  });

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

  const removedMember = await runInTransaction(prisma, async (tx) => {
    await lockRefreshSessionUser(userId, { prisma: tx });
    return withDirectoryMutation(
      tx,
      [{ orgId: org.id, kind: 'membership.changed', subjectId: userId, teamId: team.id }],
      async (tx) => {
        await lockTeamMembershipRows({ userId, orgId: org.id }, { prisma: tx });
        const lockedMembership = await tx.teamMember.findFirst({
          where: {
            teamId: team.id,
            userId,
            status: 'ACTIVE',
          },
          // `teamRole` is read for the audit row, mirroring `removeOrganisationMember`'s `role`.
          select: { id: true, teamRole: true },
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

        return lockedMembership;
      },
    );
  });

  await auditOrg(
    {
      orgId: org.id,
      actorUserId,
      actor: params.actor,
      action: 'team_member.removed',
      targetType: 'team_member',
      targetId: removedMember.id,
      metadata: {
        teamId: team.id,
        userId,
        teamRole: removedMember.teamRole,
        via: AUDIT_VIA_MANAGER,
      },
    },
    { prisma },
  );

  return { removed: true };
}
