import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

import {
  assertDatabaseEnabled,
  ensureOrgName,
  isP2002Error,
  isP2003Error,
  normalizeDomain,
  parseOrgFeatureRoles,
  resolveOrganisationByDomain,
  toListLimit,
  toOrganisationRecord,
  deriveSlugWithValidation,
  getOrganisationMember,
  type CursorList,
  type OrgServiceDeps,
  type OrgServicePrisma,
  type OrganisationRecord,
} from './organisation.service.base.js';

export async function listOrganisationsForDomain(
  params: { domain: string; limit?: number; cursor?: string },
  deps?: OrgServiceDeps,
): Promise<CursorList<OrganisationRecord>> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const domain = normalizeDomain(params.domain);
  if (!domain) throw new AppError('BAD_REQUEST', 400);

  const limit = toListLimit(params.limit);
  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const where = { domain };
  const cursor = params.cursor?.trim();

  const rows = await prisma.organisation.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
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

  const data = rows.slice(0, limit).map(toOrganisationRecord);
  const nextCursorRow = rows[limit];

  return { data, next_cursor: nextCursorRow ? nextCursorRow.id : null };
}

export async function createOrganisation(
  params: {
    domain: string;
    name: string;
    ownerId: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<OrganisationRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const domain = normalizeDomain(params.domain);
  const ownerId = params.ownerId.trim();
  const name = ensureOrgName(params.name);
  if (!ownerId || !domain) throw new AppError('BAD_REQUEST', 400);
  parseOrgFeatureRoles(params.config); // validates array is usable for later writes.

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);

  return await prisma.$transaction(async (tx) => {
    const ownerInDomainOrg = await tx.orgMember.findFirst({
      where: {
        userId: ownerId,
        org: { domain },
      },
      select: { id: true },
    });
    if (ownerInDomainOrg) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const userExists = await tx.user.findUnique({
      where: { id: ownerId },
      select: { id: true },
    });
    if (!userExists) throw new AppError('BAD_REQUEST', 400);

    const slug = await deriveSlugWithValidation(domain, tx, name);
    const createdOrg = await tx.organisation.create({
      data: {
        domain,
        name,
        slug,
        ownerId,
      },
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

    const defaultTeam = await tx.team.create({
      data: {
        orgId: createdOrg.id,
        name: 'General',
        isDefault: true,
      },
      select: { id: true },
    });

    try {
      await tx.orgMember.create({
        data: {
          orgId: createdOrg.id,
          userId: ownerId,
          role: 'owner',
        },
      });
    } catch (err) {
      if (isP2002Error(err) || isP2003Error(err)) {
        throw new AppError('BAD_REQUEST', 400);
      }
      throw err;
    }

    await tx.teamMember.create({
      data: {
        teamId: defaultTeam.id,
        userId: ownerId,
      },
    });

    return toOrganisationRecord(createdOrg);
  });
}

export async function getOrganisation(
  params: { orgId: string; domain: string },
  deps?: OrgServiceDeps,
): Promise<OrganisationRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const row = await resolveOrganisationByDomain(prisma, params);
  return toOrganisationRecord(row);
}

export async function updateOrganisation(
  params: {
    orgId: string;
    domain: string;
    name: string;
    actorUserId: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<OrganisationRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  if (!actorUserId) throw new AppError('BAD_REQUEST', 400);
  const name = ensureOrgName(params.name);
  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, params);

  const actorMembership = await getOrganisationMember(prisma, { orgId: org.id, userId: actorUserId });
  if (!actorMembership || (actorMembership.role !== 'owner' && actorMembership.role !== 'admin')) {
    throw new AppError('FORBIDDEN', 403);
  }

  const slug = await deriveSlugWithValidation(org.domain, prisma, name, org.slug);
  const updated = await prisma.organisation.update({
    where: { id: org.id },
    data: { name, slug },
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

  return toOrganisationRecord(updated);
}

export async function deleteOrganisation(
  params: {
    orgId: string;
    domain: string;
    actorUserId: string;
  },
  deps?: OrgServiceDeps,
): Promise<{ deleted: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  if (!actorUserId) throw new AppError('BAD_REQUEST', 400);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, params);
  if (org.ownerId !== actorUserId) {
    throw new AppError('FORBIDDEN', 403);
  }

  try {
    await prisma.organisation.delete({ where: { id: org.id } });
  } catch (err) {
    if (isP2003Error(err)) {
      throw new AppError('BAD_REQUEST', 400);
    }
    throw err;
  }

  return { deleted: true };
}
