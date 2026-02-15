import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';

import { toTeamRecord } from './team.service.base.js';
import {
  assertDatabaseEnabled,
  assertGroupFeaturesEnabled,
  normalizeGroupDescription,
  normalizeGroupName,
  parseMaxGroupsPerOrg,
  resolveOrganisationByDomain,
  toGroupRecord,
  toListLimit,
  toGroupMemberRecord,
  type CursorList,
  type GroupRecord,
  type GroupWithMembersRecord,
  type OrgServiceDeps,
  type OrgServicePrisma,
} from './group.service.base.js';
import { AppError } from '../utils/errors.js';

export async function listGroups(
  params: {
    orgId: string;
    domain: string;
    config: ClientConfig;
    limit?: number;
    cursor?: string;
  },
  deps?: OrgServiceDeps,
): Promise<CursorList<GroupRecord>> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);
  assertGroupFeaturesEnabled(params.config);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);

  const org = await resolveOrganisationByDomain(prisma, {
    orgId: params.orgId,
    domain: params.domain,
  });

  const limit = toListLimit(params.limit);
  const cursor = params.cursor?.trim();

  const rows = await prisma.group.findMany({
    where: { orgId: org.id },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
    select: {
      id: true,
      orgId: true,
      name: true,
      description: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const data = rows.slice(0, limit).map(toGroupRecord);
  const nextCursorRow = rows[limit];

  return { data, next_cursor: nextCursorRow ? nextCursorRow.id : null };
}

export async function createGroup(
  params: {
    orgId: string;
    domain: string;
    name: string;
    description?: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<GroupRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);
  assertGroupFeaturesEnabled(params.config);

  const maxGroups = parseMaxGroupsPerOrg(params.config);
  const name = normalizeGroupName(params.name);
  const description = normalizeGroupDescription(params.description);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, {
    orgId: params.orgId,
    domain: params.domain,
  });

  const groupCount = await prisma.group.count({ where: { orgId: org.id } });
  if (groupCount >= maxGroups) throw new AppError('BAD_REQUEST', 400);

  try {
    const created = await prisma.group.create({
      data: {
        orgId: org.id,
        name,
        ...(description === undefined ? {} : { description }),
      },
      select: {
        id: true,
        orgId: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return toGroupRecord(created);
  } catch (err) {
    const maybeConflict = (err as { code?: string } | null)?.code === 'P2002';
    if (maybeConflict) throw new AppError('BAD_REQUEST', 400);
    throw err;
  }
}

export async function getGroup(
  params: {
    orgId: string;
    groupId: string;
    domain: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<GroupWithMembersRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);
  assertGroupFeaturesEnabled(params.config);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, {
    orgId: params.orgId,
    domain: params.domain,
  });

  const row = await prisma.group.findFirst({
    where: {
      id: params.groupId.trim(),
      orgId: org.id,
    },
    select: {
      id: true,
      orgId: true,
      name: true,
      description: true,
      createdAt: true,
      updatedAt: true,
      teams: {
        orderBy: { createdAt: 'desc' },
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
      },
      members: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          groupId: true,
          userId: true,
          isAdmin: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!row) throw new AppError('NOT_FOUND', 404);

  return {
    ...toGroupRecord(row),
    teams: row.teams.map(toTeamRecord),
    members: row.members.map(toGroupMemberRecord),
  };
}

export async function updateGroup(
  params: {
    orgId: string;
    groupId: string;
    domain: string;
    name?: string;
    description?: string | null;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<GroupRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);
  assertGroupFeaturesEnabled(params.config);

  const hasUpdates = params.name !== undefined || params.description !== undefined;
  if (!hasUpdates) throw new AppError('BAD_REQUEST', 400);

  const data: Partial<{ name: string; description: string | null }> = {};
  if (params.name !== undefined) data.name = normalizeGroupName(params.name);
  if (params.description !== undefined) data.description = normalizeGroupDescription(params.description);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, {
    orgId: params.orgId,
    domain: params.domain,
  });

  const groupId = params.groupId.trim();
  if (!groupId) throw new AppError('BAD_REQUEST', 400);

  const group = await prisma.group.findFirst({
    where: { id: groupId, orgId: org.id },
    select: { id: true },
  });
  if (!group) throw new AppError('NOT_FOUND', 404);

  try {
    const updated = await prisma.group.update({
      where: { id: group.id },
      data,
      select: {
        id: true,
        orgId: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return toGroupRecord(updated);
  } catch (err) {
    const maybeConflict = (err as { code?: string } | null)?.code === 'P2002';
    if (maybeConflict) throw new AppError('BAD_REQUEST', 400);
    throw err;
  }
}

export async function deleteGroup(
  params: {
    orgId: string;
    groupId: string;
    domain: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<{ deleted: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);
  assertGroupFeaturesEnabled(params.config);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, {
    orgId: params.orgId,
    domain: params.domain,
  });
  const groupId = params.groupId.trim();
  if (!groupId) throw new AppError('BAD_REQUEST', 400);

  const group = await prisma.group.findFirst({
    where: { id: groupId, orgId: org.id },
    select: { id: true },
  });
  if (!group) throw new AppError('NOT_FOUND', 404);

  await prisma.group.delete({ where: { id: group.id } });

  return { deleted: true };
}
