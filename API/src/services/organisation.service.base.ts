import { randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
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

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

export function assertDatabaseEnabled(env: ReturnType<typeof getEnv>): void {
  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }
}

export function isP2002Error(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export function isP2003Error(err: unknown): err is Prisma.PrismaClientKnownRequestError {
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

export function ensureOrgName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) {
    throw new AppError('BAD_REQUEST', 400);
  }
  return trimmed;
}

export function ensureOrgRole(role: string, allowedRoles: string[]): void {
  if (!allowedRoles.includes(role)) {
    throw new AppError('BAD_REQUEST', 400);
  }
}

export function toListLimit(limit?: number): number {
  const resolved = limit == null ? 50 : Math.trunc(limit);
  if (!Number.isFinite(resolved) || resolved <= 0) return 1;
  return Math.min(200, resolved);
}

export async function resolveOrganisationByDomain(
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

export function toOrganisationRecord(row: {
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

export function toMemberRecord(row: {
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

export function deriveSlugWithValidation(
  domain: string,
  prisma: Pick<OrgServicePrisma, 'organisation'>,
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

export async function resolveUniqueSlugWithCollisionRetries(
  domain: string,
  prisma: Pick<OrgServicePrisma, 'organisation'>,
  base: string,
  existingSlugToIgnore?: string,
): Promise<string> {
  const normalizedIgnore = existingSlugToIgnore?.trim();
  let candidate = base;

  for (let attempt = 0; attempt < SLUG_RANDOM_SUFFIX_MAX_ATTEMPTS; attempt++) {
    if (candidate === normalizedIgnore) {
      return candidate;
    }

    const exists = await prisma.organisation.findFirst({
      where: { domain, slug: candidate },
      select: { id: true },
    });
    if (!exists) return candidate;

    const basePart = base.slice(0, Math.max(1, 120 - (1 + SLUG_SUFFIX_LENGTH)));
    candidate = `${basePart}-${randomSuffix()}`.replace(/-+$/g, '');
  }

  throw new AppError('INTERNAL', 500, 'ORG_SLUG_COLLISION_RETRY_EXHAUSTED');
}

export async function getOrganisationMember(
  prisma: OrgServicePrisma,
  params: { orgId: string; userId: string },
): Promise<{ id: string; orgId: string; userId: string; role: string } | null> {
  return await prisma.orgMember.findFirst({
    where: { orgId: params.orgId, userId: params.userId },
    select: { id: true, orgId: true, userId: true, role: true },
  });
}

export function parseOrgLimit(config: ClientConfig): number {
  return config.org_features?.max_members_per_org ?? 1000;
}

export function parseOrgFeatureRoles(config: ClientConfig): string[] {
  return resolveOrgRoles(config);
}

export type { OrgServicePrisma, OrgServiceDeps };
