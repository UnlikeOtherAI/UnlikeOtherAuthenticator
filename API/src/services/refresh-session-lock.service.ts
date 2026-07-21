import { Prisma, type PrismaClient } from '@prisma/client';

import { normalizeDomain } from '../utils/domain.js';

type RefreshSessionLockPrisma = Pick<PrismaClient, '$queryRaw'>;

const REFRESH_SESSION_LOCK_NAMESPACE = 'uoa:refresh-session:user-domain:v1';

/**
 * Serialize refresh-family decisions with same-domain membership lifecycle changes for one user.
 * The 64-bit advisory key is intentionally user+domain scoped: unrelated users and products never
 * contend, while legacy unscoped rows have exactly enough identity to participate.
 */
export async function lockRefreshSessionUserDomain(
  params: { userId: string; domain: string },
  deps: { prisma: RefreshSessionLockPrisma },
): Promise<void> {
  const lockIdentity = JSON.stringify([
    REFRESH_SESSION_LOCK_NAMESPACE,
    params.userId.trim(),
    normalizeDomain(params.domain),
  ]);
  await deps.prisma.$queryRaw(
    Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0))::text AS "lockResult"
    `,
  );
}
