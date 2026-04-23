import type { DomainRole, PrismaClient, UserRole } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Ensures a per-domain role row exists for a given user.
 *
 * Brief 18 + 22.5: first SUPERUSER row per domain wins, enforced by a
 * partial unique index on (domain) WHERE role='SUPERUSER'.
 *
 * The target role is decided up front with a pre-read rather than by
 * optimistic INSERT + catch(P2002). This function runs inside the login
 * interactive transaction (callback route wraps it in `withTenantTx`),
 * and in Postgres any statement error inside an interactive tx aborts
 * the whole tx (SQLSTATE 25P02). A catch-and-retry pattern therefore
 * surfaces as "transaction is aborted" on the next query.
 *
 * A genuine concurrent-first-signup race (two brand-new users on a
 * brand-new domain at the same instant) will still cause one INSERT to
 * P2002 and fail the request; the user can retry, and the retry will
 * see the newly-created SUPERUSER and be assigned USER.
 */
export async function ensureDomainRoleForUser(params: {
  domain: string;
  userId: string;
  prisma?: PrismaClient | Prisma.TransactionClient;
}): Promise<DomainRole> {
  const prisma = params.prisma ?? getAdminPrisma();
  const domain = normalizeDomain(params.domain);
  if (!domain) throw new AppError('BAD_REQUEST', 400);
  if (!params.userId) throw new AppError('BAD_REQUEST', 400);

  const existing = await prisma.domainRole.findUnique({
    where: { domain_userId: { domain, userId: params.userId } },
  });
  if (existing) return existing;

  const existingSuperuser = await prisma.domainRole.findFirst({
    where: { domain, role: 'SUPERUSER' },
    select: { userId: true },
  });
  const role: UserRole = existingSuperuser ? 'USER' : 'SUPERUSER';

  return await prisma.domainRole.create({
    data: { domain, userId: params.userId, role },
  });
}
