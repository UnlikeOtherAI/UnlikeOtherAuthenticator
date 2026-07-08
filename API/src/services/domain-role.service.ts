import type { DomainRole, PrismaClient, UserRole } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import { getAdminAuthDomain, getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';

type DomainRoleReader = { domainRole: Pick<PrismaClient['domainRole'], 'findUnique'> };

/**
 * A "platform superuser" is any user holding SUPERUSER on ADMIN_AUTH_DOMAIN —
 * i.e. anyone granted access via the Admin > Super-users page. Such users are
 * treated as superuser in `claims.role` for tokens issued on ANY domain, so an
 * admin-panel grant is reflected by every client website, not just the admin UI.
 * The per-domain SUPERUSER (first-login bootstrap) still applies on top of this.
 *
 * This reads the admin-domain row, so callers must pass a BYPASSRLS admin client
 * (`request.adminDb` / `getAdminPrisma()`): a tenant-scoped connection is
 * RLS-scoped to its own `app.domain` and cannot see the admin-domain row.
 */
export async function isPlatformSuperuser(params: {
  userId: string;
  prisma: DomainRoleReader;
  env?: ReturnType<typeof getEnv>;
}): Promise<boolean> {
  if (!params.userId) return false;
  const adminDomain = normalizeDomain(getAdminAuthDomain(params.env ?? getEnv()));
  if (!adminDomain) return false;
  const row = await params.prisma.domainRole.findUnique({
    where: { domain_userId: { domain: adminDomain, userId: params.userId } },
    select: { role: true },
  });
  return row?.role === 'SUPERUSER';
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
