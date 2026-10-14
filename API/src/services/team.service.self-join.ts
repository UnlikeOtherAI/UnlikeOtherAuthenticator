import { withDirectoryMembershipMutation } from './directory-user-mutation.service.js';
import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { auditOrg, type OrgActorProvenance } from './organisation.service.base.js';
import { lockTeamMembershipRows } from './team-scope.service.js';
import {
  assertDatabaseEnabled,
  normalizeTeamRole,
  parseMaxMembersPerTeam,
  parseMaxTeamMembershipsPerUser,
  resolveAndAuthorizeTeamOrg,
  toTeamMemberRecord,
  type OrgServiceDeps,
  type OrgServicePrisma,
  type TeamMemberRecord,
  isP2002Error,
} from './team.service.base.js';

/**
 * Self-join (Phase 4, design §4.6): `POST /org/organisations/:orgId/teams/:teamId/join`. Allowed
 * only when the team's `joinPolicy` is `OPEN_TO_ORG` and the caller is an ACTIVE member of the
 * team's org (`resolveAndAuthorizeTeamOrg` already enforces the latter). Reactivates a prior
 * REMOVED row as the default member rather than restoring its old role. A DEACTIVATED
 * row is an administrative suspension and needs explicit administrator reactivation. Every rejection is the same generic error — no oracle on why
 * self-join failed (team not found vs. wrong policy vs. already a member all look identical).
 */
export async function selfJoinTeam(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId: string;
    actor?: OrgActorProvenance;
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

  const selfJoinRole = normalizeTeamRole(undefined, params.config);
  const maxMembersPerTeam = parseMaxMembersPerTeam(params.config);
  const maxTeamMembershipsPerUser = parseMaxTeamMembershipsPerUser(params.config);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    actorUserId,
  });

  const team = await prisma.team.findFirst({
    where: { id: params.teamId, orgId: org.id },
    select: { id: true, joinPolicy: true },
  });
  if (!team || team.joinPolicy !== 'OPEN_TO_ORG') {
    throw new AppError('BAD_REQUEST', 400);
  }

  const record = await withDirectoryMembershipMutation(
    prisma,
    [actorUserId],
    [{ orgId: org.id, kind: 'membership.changed', subjectId: actorUserId, teamId: team.id }],
    async (tx) => {
      await lockTeamMembershipRows(
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
      if (existing && existing.status !== 'REMOVED') {
        throw new AppError('BAD_REQUEST', 400);
      }

      try {
        return existing
          ? await tx.teamMember.update({
              where: { id: existing.id },
              data: { teamRole: selfJoinRole, status: 'ACTIVE', statusChangedAt: new Date() },
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
              data: { teamId: team.id, userId: actorUserId, teamRole: selfJoinRole },
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
    },
  );

  await auditOrg({
    orgId: org.id,
    actorUserId,
    actor: params.actor,
    action: 'team_member.added',
    targetType: 'team_member',
    targetId: record.id,
    metadata: { teamId: team.id, via: 'self_join' },
  });

  return toTeamMemberRecord(record, org.domain);
}
