import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

import {
  assertDatabaseEnabled,
  normalizeTeamDescription,
  normalizeTeamName,
  parseMaxTeamsPerOrg,
  requireTeamManager,
  resolveAndAuthorizeTeamOrg,
  toListLimit,
  toTeamMemberRecord,
  toTeamRecord,
  type CursorList,
  type OrgServiceDeps,
  type OrgServicePrisma,
  type TeamRecord,
  type TeamWithMembersRecord,
  isP2002Error,
} from './team.service.base.js';

export async function listTeams(
  params: {
    orgId: string;
    domain: string;
    actorUserId: string;
    limit?: number;
    cursor?: string;
  },
  deps?: OrgServiceDeps,
): Promise<CursorList<TeamRecord>> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  if (!actorUserId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    domain: params.domain,
    actorUserId,
  });

  const limit = toListLimit(params.limit);
  const cursor = params.cursor?.trim();

  const rows = await prisma.team.findMany({
    where: { orgId: org.id },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
    select: {
      id: true,
      orgId: true,
      groupId: true,
      name: true,
      description: true,
      isDefault: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const data = rows.slice(0, limit).map(toTeamRecord);
  const nextCursorRow = rows[limit];

  return { data, next_cursor: nextCursorRow ? nextCursorRow.id : null };
}

export async function createTeam(
  params: {
    orgId: string;
    domain: string;
    actorUserId: string;
    name: string;
    description?: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<TeamRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  const name = normalizeTeamName(params.name);
  const description = normalizeTeamDescription(params.description);
  const maxTeams = parseMaxTeamsPerOrg(params.config);

  if (!actorUserId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    domain: params.domain,
    actorUserId,
  });

  await requireTeamManager(prisma, org.id, actorUserId);

  return await prisma.$transaction(async (tx) => {
    const teamCount = await tx.team.count({ where: { orgId: org.id } });
    if (teamCount >= maxTeams) {
      throw new AppError('BAD_REQUEST', 400);
    }

    try {
      const created = await tx.team.create({
        data: {
          orgId: org.id,
          name,
          ...(description === undefined ? {} : { description }),
        },
        select: {
          id: true,
          orgId: true,
          groupId: true,
          name: true,
          description: true,
          isDefault: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return toTeamRecord(created);
    } catch (err) {
      if (isP2002Error(err)) {
        throw new AppError('BAD_REQUEST', 400);
      }
      throw err;
    }
  });
}

export async function getTeam(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId: string;
  },
  deps?: OrgServiceDeps,
): Promise<TeamWithMembersRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  if (!actorUserId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    domain: params.domain,
    actorUserId,
  });

  const row = await prisma.team.findFirst({
    where: {
      id: params.teamId,
      orgId: org.id,
    },
    select: {
      id: true,
      orgId: true,
      groupId: true,
      name: true,
      description: true,
      isDefault: true,
      createdAt: true,
      updatedAt: true,
      members: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          teamId: true,
          userId: true,
          teamRole: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!row) {
    throw new AppError('NOT_FOUND', 404);
  }

  return {
    ...toTeamRecord(row),
    members: row.members.map(toTeamMemberRecord),
  };
}

export async function updateTeam(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId: string;
    name?: string;
    description?: string | null;
  },
  deps?: OrgServiceDeps,
): Promise<TeamRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  if (!actorUserId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const hasUpdates = params.name !== undefined || params.description !== undefined;
  if (!hasUpdates) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const data: Partial<{ name: string; description: string | null }> = {};
  if (params.name !== undefined) {
    data.name = normalizeTeamName(params.name);
  }
  if (params.description !== undefined) {
    data.description = normalizeTeamDescription(params.description);
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    domain: params.domain,
    actorUserId,
  });
  await requireTeamManager(prisma, org.id, actorUserId);

  const existing = await prisma.team.findFirst({
    where: { id: params.teamId, orgId: org.id },
    select: { id: true },
  });
  if (!existing) {
    throw new AppError('NOT_FOUND', 404);
  }

  try {
    const updated = await prisma.team.update({
      where: { id: existing.id },
      data,
      select: {
        id: true,
        orgId: true,
        groupId: true,
        name: true,
        description: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return toTeamRecord(updated);
  } catch (err) {
    if (isP2002Error(err)) {
      throw new AppError('BAD_REQUEST', 400);
    }
    throw err;
  }
}

export async function deleteTeam(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId: string;
  },
  deps?: OrgServiceDeps,
): Promise<{ deleted: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  if (!actorUserId) {
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
    select: {
      id: true,
      isDefault: true,
    },
  });

  if (!team) {
    throw new AppError('NOT_FOUND', 404);
  }

  if (team.isDefault) {
    throw new AppError('BAD_REQUEST', 400);
  }

  await prisma.$transaction(async (tx) => {
    const defaultTeam = await tx.team.findFirst({
      where: { orgId: org.id, isDefault: true },
      select: { id: true },
    });
    if (!defaultTeam) {
      throw new AppError('INTERNAL', 500, 'DEFAULT_TEAM_MISSING');
    }

    const members = await tx.teamMember.findMany({
      where: { teamId: team.id },
      select: { userId: true },
    });

    for (const member of members) {
      const userMembershipCount = await tx.teamMember.count({
        where: {
          userId: member.userId,
          team: {
            orgId: org.id,
          },
        },
      });

      if (userMembershipCount <= 1) {
        await tx.teamMember.create({
          data: {
            teamId: defaultTeam.id,
            userId: member.userId,
          },
        });
      }
    }

    await tx.team.delete({ where: { id: team.id } });
  });

  return { deleted: true };
}
