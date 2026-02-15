import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

import {
  assertDatabaseEnabled,
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

export async function listOrganisationMembers(
  params: { orgId: string; domain: string; limit?: number; cursor?: string },
  deps?: OrgServiceDeps,
): Promise<CursorList<OrganisationMemberRecord>> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, params);

  const limit = toListLimit(params.limit);
  const cursor = params.cursor?.trim();
  const rows = await prisma.orgMember.findMany({
    where: { orgId: org.id },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
    select: {
      id: true,
      orgId: true,
      userId: true,
      role: true,
      createdAt: true,
      updatedAt: true,
    },
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

  const actorMembership = await getOrganisationMember(prisma, { orgId: org.id, userId: actorUserId });
  if (!actorMembership || (actorMembership.role !== 'owner' && actorMembership.role !== 'admin')) {
    throw new AppError('FORBIDDEN', 403);
  }

  const createdMember = await prisma.$transaction(async (tx) => {
    const existingMemberInOrg = await tx.orgMember.findFirst({
      where: { orgId: org.id, userId },
      select: { id: true },
    });
    if (existingMemberInOrg) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const existingMemberInDomain = await tx.orgMember.findFirst({
      where: {
        userId,
        org: { domain: org.domain },
      },
      select: { id: true },
    });
    if (existingMemberInDomain) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const memberCount = await tx.orgMember.count({ where: { orgId: org.id } });
    if (memberCount >= maxMembers) throw new AppError('BAD_REQUEST', 400);

    const targetUser = await tx.user.findUnique({ where: { id: userId }, select: { id: true, domain: true } });
    if (!targetUser) throw new AppError('BAD_REQUEST', 400);
    if (targetUser.domain && targetUser.domain !== org.domain) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const created = await tx.orgMember.create({
      data: {
        orgId: org.id,
        userId,
        role,
      },
      select: {
        id: true,
        orgId: true,
        userId: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const defaultTeam = await tx.team.findFirst({
      where: { orgId: org.id, isDefault: true },
      select: { id: true },
    });
    if (!defaultTeam) {
      throw new AppError('INTERNAL', 500, 'DEFAULT_TEAM_MISSING');
    }

    await tx.teamMember.create({
      data: { teamId: defaultTeam.id, userId },
    });

    return created;
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

  const member = await getOrganisationMember(prisma, { orgId: org.id, userId });
  if (!member) throw new AppError('NOT_FOUND', 404);
  if (member.userId === org.ownerId && role !== 'owner') {
    throw new AppError('BAD_REQUEST', 400);
  }

  const updated = await prisma.orgMember.update({
    where: { id: member.id },
    data: { role },
    select: {
      id: true,
      orgId: true,
      userId: true,
      role: true,
      createdAt: true,
      updatedAt: true,
    },
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
  deps?: OrgServiceDeps,
): Promise<{ removed: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  const userId = params.userId.trim();
  if (!actorUserId || !userId) throw new AppError('BAD_REQUEST', 400);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, params);

  const actorMembership = await getOrganisationMember(prisma, { orgId: org.id, userId: actorUserId });
  if (!actorMembership || (actorMembership.role !== 'owner' && actorMembership.role !== 'admin')) {
    throw new AppError('FORBIDDEN', 403);
  }

  const member = await getOrganisationMember(prisma, { orgId: org.id, userId });
  if (!member) throw new AppError('NOT_FOUND', 404);

  const ownerCount = await prisma.orgMember.count({ where: { orgId: org.id, role: 'owner' } });
  if (member.role === 'owner' && ownerCount <= 1) {
    throw new AppError('BAD_REQUEST', 400);
  }

  await prisma.$transaction(async (tx) => {
    const ownerCountTx = await tx.orgMember.count({ where: { orgId: org.id, role: 'owner' } });
    if (member.role === 'owner' && ownerCountTx <= 1) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const owners = member.userId === org.ownerId
      ? await tx.orgMember.findMany({
          where: { orgId: org.id, role: 'owner', userId: { not: member.userId } },
          select: { userId: true },
        })
      : [];

    if (member.userId === org.ownerId && owners.length) {
      await tx.organisation.update({
        where: { id: org.id },
        data: { ownerId: owners[0].userId },
      });
    }

    await tx.teamMember.deleteMany({
      where: {
        userId,
        team: {
          orgId: org.id,
        },
      },
    });
    await tx.groupMember.deleteMany({
      where: {
        userId,
        group: {
          orgId: org.id,
        },
      },
    });
    await tx.orgMember.delete({ where: { id: member.id } });
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

  const updated = await prisma.$transaction(async (tx) => {
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
