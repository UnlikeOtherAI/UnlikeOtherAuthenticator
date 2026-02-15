import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

import {
  assertDatabaseEnabled,
  getOrganisationMember,
  resolveOrganisationByDomain,
  toListLimit,
  type CursorList,
  type OrgServiceDeps,
  type OrgServicePrisma,
  isP2002Error,
} from './organisation.service.base.js';

export type TeamRecord = {
  id: string;
  orgId: string;
  groupId: string | null;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type TeamMemberRecord = {
  id: string;
  teamId: string;
  userId: string;
  teamRole: string;
  createdAt: Date;
  updatedAt: Date;
};

export type TeamWithMembersRecord = TeamRecord & {
  members: TeamMemberRecord[];
};

const ALLOWED_TEAM_ROLES = new Set(['member', 'lead']);

function normalizeTeamName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 100) {
    throw new AppError('BAD_REQUEST', 400);
  }
  return trimmed;
}

function normalizeTeamDescription(value?: string | null): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const trimmed = value.trim();
  if (trimmed.length > 500) throw new AppError('BAD_REQUEST', 400);
  return trimmed === '' ? null : trimmed;
}

function normalizeTeamRole(value: string | undefined): string {
  const role = value?.trim() ?? 'member';
  if (!ALLOWED_TEAM_ROLES.has(role)) throw new AppError('BAD_REQUEST', 400);
  return role;
}

function isTeamManager(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

function parseMaxTeamsPerOrg(config: ClientConfig): number {
  return config.org_features?.max_teams_per_org ?? 100;
}

function parseMaxMembersPerTeam(config: ClientConfig): number {
  return config.org_features?.max_members_per_team ?? 200;
}

function parseMaxTeamMembershipsPerUser(config: ClientConfig): number {
  return config.org_features?.max_team_memberships_per_user ?? 50;
}

function toTeamRecord(row: {
  id: string;
  orgId: string;
  groupId: string | null;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}): TeamRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    groupId: row.groupId,
    name: row.name,
    description: row.description,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toTeamMemberRecord(row: {
  id: string;
  teamId: string;
  userId: string;
  teamRole: string;
  createdAt: Date;
  updatedAt: Date;
}): TeamMemberRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    userId: row.userId,
    teamRole: row.teamRole,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function requireTeamManager(
  prisma: OrgServicePrisma,
  orgId: string,
  userId: string,
): Promise<void> {
  const actorMembership = await getOrganisationMember(prisma, { orgId, userId });
  if (!actorMembership || !isTeamManager(actorMembership.role)) {
    throw new AppError('FORBIDDEN', 403);
  }
}

async function resolveAndAuthorizeTeamOrg(
  prisma: OrgServicePrisma,
  params: { orgId: string; domain: string; actorUserId?: string },
): Promise<{
  id: string;
  domain: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}> {
  const org = await resolveOrganisationByDomain(prisma, {
    orgId: params.orgId,
    domain: params.domain,
  });

  if (!params.actorUserId) return org;

  const actorMembership = await getOrganisationMember(prisma, {
    orgId: org.id,
    userId: params.actorUserId,
  });
  if (!actorMembership) {
    throw new AppError('FORBIDDEN', 403);
  }

  return org;
}

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

  await prisma.team.delete({ where: { id: params.teamId } });

  return { deleted: true };
}

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
