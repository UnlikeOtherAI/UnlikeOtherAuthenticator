import { randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

type OrgServicePrisma = PrismaClient & {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
};

type OrgServiceDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: OrgServicePrisma;
};

export type CursorList<T> = {
  data: T[];
  next_cursor: string | null;
};

export type OrganisationRecord = {
  id: string;
  domain: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type OrganisationMemberRecord = {
  id: string;
  orgId: string;
  userId: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
};

const RESERVED_ORG_SLUGS = new Set([
  'admin',
  'api',
  'internal',
  'me',
  'system',
  'settings',
  'new',
  'default',
]);

const SLUG_ALLOWED_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SLUG_RANDOM_SUFFIX_MAX_ATTEMPTS = 10;
const SLUG_SUFFIX_LENGTH = 4;

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function assertDatabaseEnabled(env: ReturnType<typeof getEnv>): void {
  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }
}

function isP2002Error(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function isP2003Error(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
}

function normalizeSlugBase(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '');

  return normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function randomSuffix(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(SLUG_SUFFIX_LENGTH);

  let out = '';
  for (const byte of bytes) {
    out += chars[byte % chars.length];
  }

  return out;
}

function ensureOrgName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) {
    throw new AppError('BAD_REQUEST', 400);
  }
  return trimmed;
}

function ensureOrgRole(role: string, allowedRoles: string[]): void {
  if (!allowedRoles.includes(role)) {
    throw new AppError('BAD_REQUEST', 400);
  }
}

function toListLimit(limit?: number): number {
  const resolved = limit == null ? 50 : Math.trunc(limit);
  if (!Number.isFinite(resolved) || resolved <= 0) return 1;
  return Math.min(200, resolved);
}

async function resolveOrganisationByDomain(
  prisma: OrgServicePrisma,
  params: { orgId: string; domain: string },
): Promise<{ id: string; domain: string; name: string; slug: string; ownerId: string; createdAt: Date; updatedAt: Date }> {
  const orgId = params.orgId.trim();
  const domain = normalizeDomain(params.domain);
  if (!orgId || !domain) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const row = await prisma.organisation.findFirst({
    where: { id: orgId, domain },
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

  if (!row) throw new AppError('NOT_FOUND', 404);
  return row;
}

function resolveOrgRoles(config: ClientConfig): string[] {
  return (
    config.org_features?.org_roles && config.org_features.org_roles.length > 0
      ? config.org_features.org_roles
      : ['owner', 'admin', 'member']
  );
}

function toOrganisationRecord(row: {
  id: string;
  domain: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}): OrganisationRecord {
  return {
    id: row.id,
    domain: row.domain,
    name: row.name,
    slug: row.slug,
    ownerId: row.ownerId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMemberRecord(row: {
  id: string;
  orgId: string;
  userId: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}): OrganisationMemberRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    role: row.role,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function deriveSlugWithValidation(
  domain: string,
  prisma: OrgServicePrisma,
  name: string,
  existingSlugToIgnore?: string,
): Promise<string> {
  const base = normalizeSlugBase(name);
  if (base.length > 120) {
    const trimmed = base.slice(0, 120);
    const final = trimmed.replace(/-+$/g, '');
    if (final.length < 2) throw new AppError('BAD_REQUEST', 400);
    return resolveUniqueSlugWithCollisionRetries(domain, prisma, final, existingSlugToIgnore);
  }

  if (base.length < 2 || base.length > 120 || !SLUG_ALLOWED_RE.test(base)) {
    throw new AppError('BAD_REQUEST', 400);
  }
  if (RESERVED_ORG_SLUGS.has(base)) {
    throw new AppError('BAD_REQUEST', 400);
  }

  return resolveUniqueSlugWithCollisionRetries(domain, prisma, base, existingSlugToIgnore);
}

async function resolveUniqueSlugWithCollisionRetries(
  domain: string,
  prisma: OrgServicePrisma,
  base: string,
  existingSlugToIgnore?: string,
): Promise<string> {
  const reserved = new Set<string>(existingSlugToIgnore ? [existingSlugToIgnore] : []);
  let candidate = base;

  for (let attempt = 0; attempt < SLUG_RANDOM_SUFFIX_MAX_ATTEMPTS; attempt++) {
    if (!reserved.has(candidate)) {
      const exists = await prisma.organisation.findFirst({
        where: { domain, slug: candidate },
        select: { id: true },
      });
      if (!exists) return candidate;
    }

    const basePart = base.slice(0, Math.max(1, 120 - (1 + SLUG_SUFFIX_LENGTH)));
    candidate = `${basePart}-${randomSuffix()}`.replace(/-+$/g, '');
  }

  throw new AppError('INTERNAL', 500, 'ORG_SLUG_COLLISION_RETRY_EXHAUSTED');
}

async function getOrganisationMember(
  prisma: OrgServicePrisma,
  params: { orgId: string; userId: string },
): Promise<{ id: string; orgId: string; userId: string; role: string } | null> {
  return await prisma.orgMember.findFirst({
    where: { orgId: params.orgId, userId: params.userId },
    select: { id: true, orgId: true, userId: true, role: true },
  });
}

function parseOrgLimit(config: ClientConfig): number {
  return config.org_features?.max_members_per_org ?? 1000;
}

function parseOrgFeatureRoles(config: ClientConfig): string[] {
  return resolveOrgRoles(config);
}

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
    actorUserId?: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<OrganisationRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId?.trim();
  const name = ensureOrgName(params.name);
  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, params);

  if (actorUserId) {
    const actorMembership = await getOrganisationMember(prisma, { orgId: org.id, userId: actorUserId });
    if (!actorMembership || (actorMembership.role !== 'owner' && actorMembership.role !== 'admin')) {
      throw new AppError('FORBIDDEN', 403);
    }
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
