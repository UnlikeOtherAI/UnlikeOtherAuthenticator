import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

type RefreshTokenPrisma = Pick<PrismaClient, 'refreshToken'>;

type RefreshTokenDeps = {
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

  // Inherit the original session's TTL so rotated tokens keep the same lifetime.
  const inheritedTtlSeconds = Math.round(
    (row.expiresAt.getTime() - row.createdAt.getTime()) / 1000,
  );
  const nextRefreshToken = await issueRefreshToken(
    {
      userId: row.userId,
      familyId: row.familyId,
      parentTokenId: row.id,
      domain: row.domain,
      clientId: row.clientId,
      configUrl: row.configUrl,
    },
    {
      ...deps,
      refreshTokenTtlSeconds: inheritedTtlSeconds > 0 ? inheritedTtlSeconds : undefined,
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
      domain: true,
      clientId: true,
      configUrl: true,
    },
  });

  if (!row || !matchesRefreshTokenContext(row, params)) {
    return;
  }

  await revokeRefreshTokenFamilyInternal(prisma, row.familyId, now);
}
