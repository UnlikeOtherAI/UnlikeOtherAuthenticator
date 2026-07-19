import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { getEnv, requireEnv } from '../config/env.js';
import { getAdminPrisma, getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

const MIN_INHERITED_REFRESH_TTL_SECONDS = 5 * 60;

type RefreshTokenPrisma = Pick<PrismaClient, 'refreshToken'>;
type UserVersionPrisma = Pick<PrismaClient, 'user'>;

type RefreshTokenDeps = {
  beforeRotate?: (row: {
    userId: string;
    domain: string;
  }) => Promise<void>;
  now?: () => Date;
  prisma?: RefreshTokenPrisma;
  refreshTokenTtlDays?: number;
  /** Override TTL in seconds. Takes precedence over refreshTokenTtlDays when set. */
  refreshTokenTtlSeconds?: number;
  sharedSecret?: string;
};

type RefreshTokenContext = {
  clientId: string;
  configUrl: string;
  domain: string;
};

function generateRefreshTokenValue(): string {
  return randomBytes(48).toString('base64url');
}

function generateRefreshTokenFamilyId(): string {
  return randomUUID();
}

function hashRefreshToken(token: string, pepper: string): string {
  return createHmac('sha256', pepper).update(token, 'utf8').digest('hex');
}

function nowDate(deps?: RefreshTokenDeps): Date {
  return deps?.now ? deps.now() : new Date();
}

function getSharedSecret(deps?: RefreshTokenDeps): string {
  return deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
}

function getRefreshTokenTtlDays(deps?: RefreshTokenDeps): number {
  return deps?.refreshTokenTtlDays ?? getEnv().REFRESH_TOKEN_TTL_DAYS;
}

function getRefreshTokenTtlSeconds(deps?: RefreshTokenDeps): number {
  if (deps?.refreshTokenTtlSeconds != null) return deps.refreshTokenTtlSeconds;
  return getRefreshTokenTtlDays(deps) * 24 * 60 * 60;
}

function getRefreshTokenPrisma(deps?: RefreshTokenDeps): RefreshTokenPrisma {
  return deps?.prisma ?? (getPrisma() as unknown as RefreshTokenPrisma);
}

function matchesRefreshTokenContext(
  row: {
    clientId: string;
    configUrl: string;
    domain: string;
  },
  context: RefreshTokenContext,
): boolean {
  return (
    row.clientId === context.clientId &&
    row.configUrl === context.configUrl &&
    row.domain === context.domain
  );
}

async function revokeRefreshTokenFamilyInternal(
  prisma: RefreshTokenPrisma,
  familyId: string,
  revokedAt: Date,
): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: {
      familyId,
      revokedAt: null,
    },
    data: {
      revokedAt,
    },
  });
}

export async function issueRefreshToken(
  params: RefreshTokenContext & {
    familyId?: string;
    parentTokenId?: string;
    userId: string;
    // Workspace scope carried from the authorization code / prior refresh token (design §7 step
    // 3-4); defaults to null when no workspace was selected.
    orgId?: string | null;
    teamId?: string | null;
  },
  deps?: RefreshTokenDeps,
): Promise<{
  expiresInSeconds: number;
  refreshToken: string;
  refreshTokenId: string;
}> {
  const prisma = getRefreshTokenPrisma(deps);
  const now = nowDate(deps);
  const ttlSeconds = getRefreshTokenTtlSeconds(deps);
  const sharedSecret = getSharedSecret(deps);
  const refreshToken = generateRefreshTokenValue();
  const tokenHash = hashRefreshToken(refreshToken, sharedSecret);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const row = await prisma.refreshToken.create({
    data: {
      tokenHash,
      familyId: params.familyId ?? generateRefreshTokenFamilyId(),
      parentTokenId: params.parentTokenId,
      userId: params.userId,
      domain: params.domain,
      clientId: params.clientId,
      configUrl: params.configUrl,
      orgId: params.orgId ?? null,
      teamId: params.teamId ?? null,
      expiresAt,
    },
    select: {
      id: true,
    },
  });

  return {
    refreshToken,
    refreshTokenId: row.id,
    expiresInSeconds: ttlSeconds,
  };
}

export async function exchangeRefreshToken(
  params: RefreshTokenContext & {
    refreshToken: string;
  },
  deps?: RefreshTokenDeps,
): Promise<{
  expiresInSeconds: number;
  refreshToken: string;
  userId: string;
  orgId: string | null;
  teamId: string | null;
}> {
  const prisma = getRefreshTokenPrisma(deps);
  const now = nowDate(deps);
  const sharedSecret = getSharedSecret(deps);
  const tokenHash = hashRefreshToken(params.refreshToken, sharedSecret);

  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      familyId: true,
      userId: true,
      domain: true,
      clientId: true,
      configUrl: true,
      createdAt: true,
      expiresAt: true,
      revokedAt: true,
      replacedByTokenId: true,
      orgId: true,
      teamId: true,
    },
  });

  if (!row) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
  }

  if (!matchesRefreshTokenContext(row, params)) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
  }

  if (row.replacedByTokenId) {
    await revokeRefreshTokenFamilyInternal(prisma, row.familyId, now);
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
  }

  if (row.revokedAt || row.expiresAt.getTime() <= now.getTime()) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
  }

  // Policy gates run here, after the opaque token and its exact client context
  // have been validated but before any replacement row or mutation is written.
  // Callers that need a policy/rotation atomicity guarantee must pass a Prisma
  // transaction as `prisma` and perform the gate through this hook.
  await deps?.beforeRotate?.({ userId: row.userId, domain: row.domain });

  // Inherit the original session's TTL so rotated tokens keep the same lifetime.
  const inheritedTtlSeconds = Math.round(
    (row.expiresAt.getTime() - row.createdAt.getTime()) / 1000,
  );
  const refreshTokenTtlSeconds = Math.max(
    inheritedTtlSeconds,
    MIN_INHERITED_REFRESH_TTL_SECONDS,
  );

  const nextRefreshToken = await issueRefreshToken(
    {
      userId: row.userId,
      familyId: row.familyId,
      parentTokenId: row.id,
      domain: row.domain,
      clientId: row.clientId,
      configUrl: row.configUrl,
      // Rotation preserves the session's workspace scope (design §7 step 4).
      orgId: row.orgId,
      teamId: row.teamId,
    },
    {
      ...deps,
      refreshTokenTtlSeconds,
    },
  );

  const rotated = await prisma.refreshToken.updateMany({
    where: {
      id: row.id,
      revokedAt: null,
      replacedByTokenId: null,
      expiresAt: {
        gt: now,
      },
    },
    data: {
      lastUsedAt: now,
      revokedAt: now,
      replacedByTokenId: nextRefreshToken.refreshTokenId,
    },
  });

  if (rotated.count !== 1) {
    await revokeRefreshTokenFamilyInternal(prisma, row.familyId, now);
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
  }

  return {
    userId: row.userId,
    refreshToken: nextRefreshToken.refreshToken,
    expiresInSeconds: nextRefreshToken.expiresInSeconds,
    orgId: row.orgId,
    teamId: row.teamId,
  };
}

export async function revokeRefreshTokenFamily(
  params: RefreshTokenContext & {
    refreshToken: string;
  },
  deps?: RefreshTokenDeps,
): Promise<void> {
  const prisma = getRefreshTokenPrisma(deps);
  const now = nowDate(deps);
  const sharedSecret = getSharedSecret(deps);
  const tokenHash = hashRefreshToken(params.refreshToken, sharedSecret);

  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: {
      familyId: true,
      userId: true,
      domain: true,
      clientId: true,
      configUrl: true,
    },
  });

  if (!row || !matchesRefreshTokenContext(row, params)) {
    return;
  }

  await revokeRefreshTokenFamilyInternal(prisma, row.familyId, now);
  // Logout must also kill already-issued (stateless) access tokens for this
  // user, not just the refresh family. Bumping the per-user token version
  // invalidates them on their next verify.
  await bumpUserTokenVersion(row.userId, {
    prisma: deps?.prisma as unknown as UserVersionPrisma | undefined,
  });
}

/**
 * Increment a user's token version. Stateless access tokens carry a `tv` claim
 * matched against this on verify, so bumping it revokes every already-issued
 * access token for the user. Uses the admin Prisma connection to bypass
 * per-domain RLS — token version is a user-wide property, not per-domain.
 */
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

/**
 * Domain-scoped session revocation (design §4.5). Revokes every live refresh token for this user on
 * this domain. Because a user belongs to exactly one org per domain, this is the correct scope for
 * deactivating/removing an org membership. Deliberately does NOT bump the global user token version
 * (that would also invalidate the user's sessions on other domains). Existing short-lived access
 * tokens on this domain expire naturally; they simply cannot be renewed.
 */
export async function revokeRefreshTokensForUserDomain(
  userId: string,
  domain: string,
  deps?: { now?: () => Date; prisma?: RefreshTokenPrisma },
): Promise<{ revokedCount: number }> {
  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as RefreshTokenPrisma);
  const now = deps?.now ? deps.now() : new Date();
  const result = await prisma.refreshToken.updateMany({
    where: { userId, domain, revokedAt: null },
    data: { revokedAt: now },
  });
  return { revokedCount: result.count };
}

/**
 * Revoke every active refresh token belonging to a user, across all domains/clients.
 *
 * Used on credential-changing events (password reset, 2FA reset, set-password-on-verify)
 * so that an attacker holding a stolen refresh token cannot survive the user's recovery
 * action. Uses the admin Prisma connection to bypass per-domain RLS — credentials are
 * a user-wide property, not a per-domain one.
 */
export async function revokeAllRefreshTokensForUser(
  userId: string,
  deps?: { now?: () => Date; prisma?: RefreshTokenPrisma },
): Promise<void> {
  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as RefreshTokenPrisma);
  const now = deps?.now ? deps.now() : new Date();
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });
  // Also invalidate already-issued access tokens for this user.
  await bumpUserTokenVersion(userId, {
    prisma: deps?.prisma as unknown as UserVersionPrisma | undefined,
  });
}
