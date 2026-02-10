import type { PrismaClient, UserRole } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

type DomainUsersPrisma = {
  domainRole: Pick<PrismaClient['domainRole'], 'findMany'>;
};

type DomainUsersDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: DomainUsersPrisma;
};

export type DomainUserRecord = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  twoFaEnabled: boolean;
  role: 'superuser' | 'user';
  createdAt: Date;
};

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function roleToPublic(role: UserRole): 'superuser' | 'user' {
  return role === 'SUPERUSER' ? 'superuser' : 'user';
}

/**
 * Brief 17: Domain-scoped API: list users for a domain.
 *
 * Returns only non-sensitive user fields (no password hash, no 2FA secret, no user_key).
 */
export async function listUsersForDomain(
  params: { domain: string; limit?: number },
  deps?: DomainUsersDeps,
): Promise<DomainUserRecord[]> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) return [];

  const domain = normalizeDomain(params.domain);
  if (!domain) throw new AppError('BAD_REQUEST', 400);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as DomainUsersPrisma);
  const limit = Math.max(1, Math.min(500, params.limit ?? 100));

  const rows = await prisma.domainRole.findMany({
    where: { domain },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      role: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          avatarUrl: true,
          twoFaEnabled: true,
          createdAt: true,
        },
      },
    },
  });

  return rows.map((r) => ({
    id: r.user.id,
    email: r.user.email,
    name: r.user.name,
    avatarUrl: r.user.avatarUrl,
    twoFaEnabled: r.user.twoFaEnabled,
    role: roleToPublic(r.role),
    createdAt: r.user.createdAt,
  }));
}

