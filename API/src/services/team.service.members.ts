import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

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

  return await prisma.$transaction(async (tx) => {
    const memberCount = await tx.teamMember.count({ where: { teamId: team.id } });
    if (memberCount >= maxMembersPerTeam) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const userMemberships = await tx.teamMember.count({
      where: {
        userId,
        team: {
          orgId: org.id,
        },
      },
    });
    if (userMemberships >= maxTeamMembershipsPerUser) {
      throw new AppError('BAD_REQUEST', 400);
    }

    try {
      const created = await tx.teamMember.create({
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

      return toTeamMemberRecord(created);
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

  const member = await prisma.teamMember.findFirst({
    where: {
      teamId: team.id,
      userId,
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
  deps?: OrgServiceDeps,
): Promise<{ removed: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  const userId = params.userId.trim();

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

  const membership = await prisma.teamMember.findFirst({
    where: {
      teamId: team.id,
      userId,
    },
    select: { id: true },
  });
  if (!membership) {
    throw new AppError('NOT_FOUND', 404);
  }

  return await prisma.$transaction(async (tx) => {
    const userTeamCount = await tx.teamMember.count({
      where: {
        userId,
        team: {
          orgId: org.id,
        },
      },
    });

    if (userTeamCount <= 1) {
      throw new AppError('BAD_REQUEST', 400);
    }

    await tx.teamMember.delete({ where: { id: membership.id } });

    return { removed: true };
  });
}
