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

/**
 * Ensures a per-domain role row exists for a given user.
 *
 * Brief 18 + 22.5:
 * - First successfully created SUPERUSER row per domain wins (DB constraint).
 * - No locks/queues; resolve races at constraint level.
 *
 * Write-path:
 * - Try insert SUPERUSER
 * - On any unique conflict (P2002), first check if (domain,user) already exists and return it
 *   (handles concurrent same-user insert regardless of role).
 * - Otherwise, insert USER (domain already has a SUPERUSER or we lost some other recoverable race).
 * - If USER insert also P2002, check for existing row again and return it; otherwise rethrow.
 */
export async function ensureDomainRoleForUser(params: {
  domain: string;
  userId: string;
  prisma?: PrismaClient | Prisma.TransactionClient;
}): Promise<DomainRole> {
  const prisma = params.prisma ?? getPrisma();
  const domain = normalizeDomain(params.domain);
  if (!domain) throw new AppError('BAD_REQUEST', 400);
  if (!params.userId) throw new AppError('BAD_REQUEST', 400);

  const existing = await prisma.domainRole.findUnique({
    where: { domain_userId: { domain, userId: params.userId } },
  });
  if (existing) return existing;

  const findExisting = async (): Promise<DomainRole | null> => {
    return await prisma.domainRole.findUnique({
      where: { domain_userId: { domain, userId: params.userId } },
    });
  };

  const createWithRole = async (role: UserRole): Promise<DomainRole> => {
    return await prisma.domainRole.create({
      data: { domain, userId: params.userId, role },
    });
  };

  try {
    return await createWithRole('SUPERUSER');
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;

    // Any P2002 is recoverable. First, check if someone inserted (domain,user) concurrently.
    const rowAfterSuperuserConflict = await findExisting();
    if (rowAfterSuperuserConflict) return rowAfterSuperuserConflict;

    // Otherwise, we lost the "first SUPERUSER per domain" race; fall back to USER.
    try {
      return await createWithRole('USER');
    } catch (err2) {
      if (!isUniqueConstraintError(err2)) throw err2;
      const rowAfterUserConflict = await findExisting();
      if (rowAfterUserConflict) return rowAfterUserConflict;
      throw err2;
    }
  }
}
