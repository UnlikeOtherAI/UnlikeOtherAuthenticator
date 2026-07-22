import { Prisma, type PrismaClient } from '@prisma/client';

import { normalizeDomain } from '../utils/domain.js';

type RefreshSessionLockPrisma = Pick<PrismaClient, '$queryRaw'>;

const REFRESH_SESSION_USER_LOCK_NAMESPACE = 'uoa:refresh-session:user:v1';
const REFRESH_SESSION_USER_DOMAIN_LOCK_NAMESPACE = 'uoa:refresh-session:user-domain:v1';

async function lockRefreshSessionKey(
  lockIdentity: string,
  prisma: RefreshSessionLockPrisma,
): Promise<void> {
  await prisma.$queryRaw(
    Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0))::text AS "lockResult"
    `,
  );
}

/** Serialize every refresh issuance or global credential revocation for one exact user. */
export async function lockRefreshSessionUser(
  userId: string,
  deps: { prisma: RefreshSessionLockPrisma },
): Promise<void> {
  await lockRefreshSessionKey(
    JSON.stringify([REFRESH_SESSION_USER_LOCK_NAMESPACE, userId.trim()]),
    deps.prisma,
  );
}

/**
 * Take the canonical user-global then user+domain hierarchy. The first lock serializes global
 * credential revocation with refresh; the second serializes same-domain family/lifecycle changes.
 */
export async function lockRefreshSessionUserDomain(
  params: { userId: string; domain: string },
  deps: { prisma: RefreshSessionLockPrisma },
): Promise<void> {
  await lockRefreshSessionUser(params.userId, deps);
  await lockRefreshSessionKey(
    JSON.stringify([
      REFRESH_SESSION_USER_DOMAIN_LOCK_NAMESPACE,
      params.userId.trim(),
      normalizeDomain(params.domain),
    ]),
    deps.prisma,
  );
}
