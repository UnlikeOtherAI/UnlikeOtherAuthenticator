import type { BanType, PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';

type BanPrisma = Pick<PrismaClient, 'ban' | 'organisation' | 'team'>;

type BanDeps = { prisma?: BanPrisma };

export type AdminBanRecord = {
  id: string;
  value: string;
  label?: string;
  bannedAt: string;
  reason?: string;
};

export type AdminBans = {
  emails: AdminBanRecord[];
  patterns: AdminBanRecord[];
  ips: AdminBanRecord[];
  users: AdminBanRecord[];
};

const EMPTY_BANS: AdminBans = { emails: [], patterns: [], ips: [], users: [] };

type BanRow = {
  id: string;
  domain: string;
  type: BanType;
  value: string;
  reason: string | null;
  createdAt: Date;
  org: { name: string } | null;
  team: { name: string } | null;
};

const banInclude = {
  org: { select: { name: true } },
  team: { select: { name: true } },
} as const;

function resolvePrisma(injected?: BanPrisma): BanPrisma | null {
  if (injected) return injected;
  return getEnv().DATABASE_URL ? (getAdminPrisma() as BanPrisma) : null;
}

/** Human-readable scope so a system admin can see where a ban applies. */
function scopeLabel(row: BanRow): string {
  if (row.team) return `${row.domain} · team ${row.team.name}`;
  if (row.org) return `${row.domain} · org ${row.org.name}`;
  return row.domain;
}

function toRecord(row: BanRow): AdminBanRecord {
  return {
    id: row.id,
    value: row.value,
    label: scopeLabel(row),
    bannedAt: row.createdAt.toISOString(),
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

const BUCKET_BY_TYPE: Record<BanType, keyof AdminBans> = {
  EMAIL: 'emails',
  PATTERN: 'patterns',
  IP: 'ips',
  USER: 'users',
};

export async function listAdminBans(deps?: BanDeps): Promise<AdminBans> {
  const prisma = resolvePrisma(deps?.prisma);
  if (!prisma) return EMPTY_BANS;

  const rows = (await prisma.ban.findMany({
    orderBy: { createdAt: 'desc' },
    include: banInclude,
  })) as BanRow[];

  const result: AdminBans = { emails: [], patterns: [], ips: [], users: [] };
  for (const row of rows) {
    result[BUCKET_BY_TYPE[row.type]].push(toRecord(row));
  }
  return result;
}

/**
 * Create a ban at exactly one scope. A `teamId` makes it a team ban, an `orgId` an
 * organisation ban, and neither a client-domain ban. The org/team must belong to the given
 * client domain (no cross-tenant bans). Re-creating an identical ban is idempotent.
 */
export async function createAdminBan(
  input: {
    type: BanType;
    value: string;
    domain: string;
    orgId?: string | null;
    teamId?: string | null;
    reason?: string | null;
    createdByEmail?: string | null;
  },
  deps?: BanDeps,
): Promise<AdminBanRecord> {
  const prisma = resolvePrisma(deps?.prisma);
  if (!prisma) throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');

  const domain = normalizeDomain(input.domain);
  const value = input.type === 'EMAIL' ? input.value.trim().toLowerCase() : input.value.trim();
  if (!value) throw new AppError('BAD_REQUEST', 400, 'INVALID_BAN_VALUE');

  let orgId: string | null = null;
  let teamId: string | null = null;
  if (input.teamId) {
    const team = await prisma.team.findUnique({
      where: { id: input.teamId },
      select: { org: { select: { domain: true } } },
    });
    if (!team || normalizeDomain(team.org.domain) !== domain) {
      throw new AppError('BAD_REQUEST', 400, 'BAN_SCOPE_INVALID');
    }
    teamId = input.teamId;
  } else if (input.orgId) {
    const org = await prisma.organisation.findUnique({
      where: { id: input.orgId },
      select: { domain: true },
    });
    if (!org || normalizeDomain(org.domain) !== domain) {
      throw new AppError('BAD_REQUEST', 400, 'BAN_SCOPE_INVALID');
    }
    orgId = input.orgId;
  }

  const existing = (await prisma.ban.findFirst({
    where: { domain, orgId, teamId, type: input.type, value },
    include: banInclude,
  })) as BanRow | null;
  if (existing) return toRecord(existing);

  const row = (await prisma.ban.create({
    data: {
      domain,
      orgId,
      teamId,
      type: input.type,
      value,
      reason: input.reason?.trim() || null,
      createdByEmail: input.createdByEmail ?? null,
    },
    include: banInclude,
  })) as BanRow;
  return toRecord(row);
}

export async function deleteAdminBan(id: string, deps?: BanDeps): Promise<{ id: string }> {
  const prisma = resolvePrisma(deps?.prisma);
  if (!prisma) throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');

  try {
    await prisma.ban.delete({ where: { id } });
  } catch {
    throw new AppError('NOT_FOUND', 404, 'BAN_NOT_FOUND');
  }
  return { id };
}
