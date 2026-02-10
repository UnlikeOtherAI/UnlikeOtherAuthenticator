import type { DomainRole, PrismaClient, UserRole } from '@prisma/client';
import { Prisma } from '@prisma/client';

import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function isUniqueConstraintError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function isSuperuserUniqueConflict(err: Prisma.PrismaClientKnownRequestError): boolean {
  // Partial unique index: domain is unique where role=SUPERUSER.
  // Prisma typically reports `meta.target` as the field(s) that were unique.
  const target = err.meta?.target;
  if (!Array.isArray(target)) return false;
  const lowered = target.map((t) => String(t).toLowerCase());
  // Primary key uniqueness usually reports both domain and user_id/userId; distinguish that.
  if (lowered.some((t) => t.includes('user'))) return false;
  return lowered.includes('domain');
}

/**
 * Ensures a per-domain role row exists for a given user.
 *
 * Brief 18 + 22.5:
 * - First successfully created SUPERUSER row per domain wins (DB constraint).
 * - No locks/queues; resolve races at constraint level.
 *
 * Write-path:
 * - Try insert SUPERUSER
 * - On unique conflict (domain already has a SUPERUSER), insert USER
 * - If row already exists (concurrent call), return existing row
 */
export async function ensureDomainRoleForUser(params: {
  domain: string;
  userId: string;
  prisma?: PrismaClient;
}): Promise<DomainRole> {
  const prisma = params.prisma ?? getPrisma();
  const domain = normalizeDomain(params.domain);
  if (!domain) throw new AppError('BAD_REQUEST', 400);
  if (!params.userId) throw new AppError('BAD_REQUEST', 400);

  const existing = await prisma.domainRole.findUnique({
    where: { domain_userId: { domain, userId: params.userId } },
  });
  if (existing) return existing;

  const createWithRole = async (role: UserRole): Promise<DomainRole> => {
    return await prisma.domainRole.create({
      data: { domain, userId: params.userId, role },
    });
  };

  try {
    return await createWithRole('SUPERUSER');
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;

    // If we lost the SUPERUSER race, fall back to USER.
    if (isSuperuserUniqueConflict(err)) {
      try {
        return await createWithRole('USER');
      } catch (err2) {
        if (!isUniqueConstraintError(err2)) throw err2;
        const row = await prisma.domainRole.findUnique({
          where: { domain_userId: { domain, userId: params.userId } },
        });
        if (row) return row;
        throw err2;
      }
    }

    // Otherwise we likely raced on (domain, userId) itself; return the existing row.
    const row = await prisma.domainRole.findUnique({
      where: { domain_userId: { domain, userId: params.userId } },
    });
    if (row) return row;
    throw err;
  }
}
