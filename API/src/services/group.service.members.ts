import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';

import {
  assertDatabaseEnabled,
  assertGroupFeaturesEnabled,
  getOrganisationMember,
  parseBooleanFlag,
  parseMaxMembersPerGroup,
  resolveOrganisationByDomain,
  toGroupMemberRecord,
  type GroupMemberRecord,
  type OrgServiceDeps,
  type OrgServicePrisma,
  isP2002Error,
} from './group.service.base.js';
import { toTeamRecord, type TeamRecord } from './team.service.base.js';
import { AppError as AppError } from '../utils/errors.js';

function getGroupIdValue(groupId: string | null): string | null {
  if (groupId === null) return null;
  return groupId.trim();
}

export async function addGroupMember(
  params: {
    orgId: string;
    groupId: string;
    domain: string;
    userId: string;
    isAdmin?: boolean;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<GroupMemberRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);
  assertGroupFeaturesEnabled(params.config);

  const userId = params.userId.trim();
  if (!userId) throw new AppError('BAD_REQUEST', 400);

  const maxMembersPerGroup = parseMaxMembersPerGroup(params.config);
  const isAdmin = parseBooleanFlag(params.isAdmin);
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

  const orgMember = await getOrganisationMember(prisma, {
    orgId: org.id,
    userId,
  });
  if (!orgMember) throw new AppError('BAD_REQUEST', 400);

  return await prisma.$transaction(async (tx) => {
    const groupMemberCount = await tx.groupMember.count({ where: { groupId: group.id } });
    if (groupMemberCount >= maxMembersPerGroup) {
      throw new AppError('BAD_REQUEST', 400);
    }

    try {
      const created = await tx.groupMember.create({
        data: {
          groupId: group.id,
          userId,
          isAdmin,
        },
        select: {
          id: true,
          groupId: true,
          userId: true,
          isAdmin: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return toGroupMemberRecord(created);
    } catch (err) {
      if (isP2002Error(err)) {
        throw new AppError('BAD_REQUEST', 400);
      }
      throw err;
    }
  });
}

export async function removeGroupMember(
  params: {
    orgId: string;
    groupId: string;
    domain: string;
    userId: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<{ removed: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);
  assertGroupFeaturesEnabled(params.config);

  const userId = params.userId.trim();
  if (!userId) throw new AppError('BAD_REQUEST', 400);

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

  const member = await prisma.groupMember.findFirst({
    where: {
      groupId: group.id,
      userId,
    },
    select: { id: true },
  });
  if (!member) throw new AppError('NOT_FOUND', 404);

  await prisma.groupMember.delete({ where: { id: member.id } });
  return { removed: true };
}

export async function updateGroupMemberAdmin(
  params: {
    orgId: string;
    groupId: string;
    domain: string;
    userId: string;
    isAdmin: boolean;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<GroupMemberRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);
  assertGroupFeaturesEnabled(params.config);

  const userId = params.userId.trim();
  if (!userId) throw new AppError('BAD_REQUEST', 400);
  if (typeof params.isAdmin !== 'boolean') throw new AppError('BAD_REQUEST', 400);

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

  const membership = await prisma.groupMember.findFirst({
    where: {
      groupId: group.id,
      userId,
    },
    select: { id: true },
  });
  if (!membership) throw new AppError('NOT_FOUND', 404);

  const updated = await prisma.groupMember.update({
    where: { id: membership.id },
    data: { isAdmin: params.isAdmin },
    select: {
      id: true,
      groupId: true,
      userId: true,
      isAdmin: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return toGroupMemberRecord(updated);
}

export async function assignTeamToGroup(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    groupId: string | null;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<TeamRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);
  assertGroupFeaturesEnabled(params.config);

  const teamId = params.teamId.trim();
  if (!teamId) throw new AppError('BAD_REQUEST', 400);

  const normalizedGroupId = getGroupIdValue(params.groupId);
  if (params.groupId !== null && !normalizedGroupId) throw new AppError('BAD_REQUEST', 400);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, {
    orgId: params.orgId,
    domain: params.domain,
  });

  const team = await prisma.team.findFirst({
    where: { id: teamId, orgId: org.id },
    select: { id: true },
  });
  if (!team) throw new AppError('NOT_FOUND', 404);

  if (normalizedGroupId) {
    const group = await prisma.group.findFirst({
      where: { id: normalizedGroupId, orgId: org.id },
      select: { id: true },
    });
    if (!group) throw new AppError('NOT_FOUND', 404);
  }

  const updated = await prisma.team.update({
    where: { id: team.id },
    data: { groupId: normalizedGroupId },
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
}
