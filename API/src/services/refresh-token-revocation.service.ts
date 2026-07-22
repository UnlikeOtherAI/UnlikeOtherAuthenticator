import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import {
  lockRefreshSessionUser,
  lockRefreshSessionUserDomain,
} from './refresh-session-lock.service.js';

type UserVersionPrisma = Pick<PrismaClient, 'user'>;
type RefreshRevocationPrisma = Pick<PrismaClient, '$queryRaw' | 'refreshToken' | 'user'> &
  Partial<Pick<PrismaClient, '$transaction'>>;

function adminRevocationPrisma(
  prisma?: RefreshRevocationPrisma,
): RefreshRevocationPrisma {
  return prisma ?? (getAdminPrisma() as unknown as RefreshRevocationPrisma);
}

/** Increment the version carried by every stateless access token for one user. */
export async function bumpUserTokenVersion(
  userId: string,
  deps?: { prisma?: UserVersionPrisma },
): Promise<void> {
  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as UserVersionPrisma);
  await prisma.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
  });
}

/** Revoke same-domain refresh state without globally invalidating access tokens. */
export async function revokeRefreshTokensForUserDomain(
  userId: string,
  domain: string,
  deps?: { now?: () => Date; prisma?: RefreshRevocationPrisma },
): Promise<{ revokedCount: number }> {
  const prisma = adminRevocationPrisma(deps?.prisma);
  const now = deps?.now ? deps.now() : new Date();
  return runInTransaction(prisma as PrismaClient, async (tx) => {
    await lockRefreshSessionUserDomain({ userId, domain }, { prisma: tx });
    const result = await tx.refreshToken.updateMany({
      where: { userId, domain, revokedAt: null },
      data: { revokedAt: now },
    });
    return { revokedCount: result.count };
  });
}

/** Revoke every live family for one exact user and organisation across issuing domains. */
export async function revokeRefreshTokenFamiliesForUserOrganisation(
  userId: string,
  orgId: string,
  deps?: { now?: () => Date; prisma?: RefreshRevocationPrisma },
): Promise<{ revokedCount: number }> {
  const prisma = adminRevocationPrisma(deps?.prisma);
  const now = deps?.now ? deps.now() : new Date();
  return runInTransaction(prisma as PrismaClient, async (tx) => {
    await lockRefreshSessionUser(userId, { prisma: tx });
    const result = await tx.refreshToken.updateMany({
      where: { userId, orgId, revokedAt: null },
      data: { revokedAt: now },
    });
    return { revokedCount: result.count };
  });
}

/** Revoke every live family for one exact user and team across issuing domains. */
export async function revokeRefreshTokenFamiliesForUserTeam(
  userId: string,
  teamId: string,
  deps?: { now?: () => Date; prisma?: RefreshRevocationPrisma },
): Promise<{ revokedCount: number }> {
  const prisma = adminRevocationPrisma(deps?.prisma);
  const now = deps?.now ? deps.now() : new Date();
  return runInTransaction(prisma as PrismaClient, async (tx) => {
    await lockRefreshSessionUser(userId, { prisma: tx });
    const result = await tx.refreshToken.updateMany({
      where: { userId, teamId, revokedAt: null },
      data: { revokedAt: now },
    });
    return { revokedCount: result.count };
  });
}

/**
 * Revoke all refresh state and bump tokenVersion atomically under the canonical user-global lock.
 * Credential writers call this from their own transaction after taking that same lock before
 * mutation. Re-acquisition is deliberate and safe: PostgreSQL transaction advisory locks are
 * re-entrant, and the public boundary remains protected when called independently.
 */
export async function revokeAllRefreshTokensForUser(
  userId: string,
  deps?: {
    afterUserLock?: () => Promise<void>;
    now?: () => Date;
    prisma?: RefreshRevocationPrisma;
  },
): Promise<void> {
  const prisma = adminRevocationPrisma(deps?.prisma);
  const now = deps?.now ? deps.now() : new Date();
  await runInTransaction(prisma as PrismaClient, async (tx) => {
    await lockRefreshSessionUser(userId, { prisma: tx });
    await deps?.afterUserLock?.();
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await bumpUserTokenVersion(userId, { prisma: tx });
  });
}
