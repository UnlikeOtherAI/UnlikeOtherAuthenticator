import { randomBytes, randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import {
  deriveRefreshTokenSuccessor,
  hashRefreshToken,
  matchesRefreshTokenContext,
  REFRESH_TOKEN_REPLAY_GRACE_MS,
  refreshTokenSelect,
  resolveRefreshTokenReplay,
  type RefreshTokenContext,
  type RefreshTokenRow,
} from './refresh-token-replay.service.js';
import { bumpUserTokenVersion } from './refresh-token-revocation.service.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';

const MIN_INHERITED_REFRESH_TTL_SECONDS = 5 * 60;
export { REFRESH_TOKEN_REPLAY_GRACE_MS };

class RefreshTokenReuseDetectedError extends AppError {
  public constructor() {
    super('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
  }
}

/** Identify the private commit signal without exposing a distinct public refresh error. */
export function isRefreshTokenReuseDetectedError(
  error: unknown,
): error is RefreshTokenReuseDetectedError {
  return error instanceof RefreshTokenReuseDetectedError;
}

type RefreshTokenPrisma = Pick<PrismaClient, 'refreshToken' | 'user'>;

type RefreshTokenDeps = {
  afterFamilyRevocationLock?: (row: {
    userId: string;
    domain: string;
    familyId: string;
  }) => Promise<void>;
  beforeFamilyRevocationLock?: () => Promise<void>;
  beforeFamilyDecision?: (row: {
    userId: string;
    domain: string;
    orgId: string | null;
    teamId: string | null;
  }) => Promise<void>;
  beforeRotate?: (row: {
    userId: string;
    domain: string;
    orgId: string | null;
    teamId: string | null;
  }) => Promise<void>;
  now?: () => Date;
  prisma?: RefreshTokenPrisma;
  refreshTokenTtlDays?: number;
  /** Override TTL in seconds. Takes precedence over refreshTokenTtlDays when set. */
  refreshTokenTtlSeconds?: number;
  sharedSecret?: string;
};

function generateRefreshTokenValue(): string {
  return randomBytes(48).toString('base64url');
}

function generateRefreshTokenFamilyId(): string {
  return randomUUID();
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

async function revokeRefreshTokenFamilyInternal(
  prisma: RefreshTokenPrisma,
  familyId: string,
  revokedAt: Date,
): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: {
      familyId,
      revokedAt: null,
    },
    data: {
      revokedAt,
    },
  });
  return result.count;
}

async function rejectRefreshTokenReuse(
  prisma: RefreshTokenPrisma,
  row: Pick<RefreshTokenRow, 'familyId' | 'userId'>,
  now: Date,
): Promise<never> {
  const revokedCount = await revokeRefreshTokenFamilyInternal(prisma, row.familyId, now);
  if (revokedCount > 0) {
    await bumpUserTokenVersion(row.userId, { prisma });
  }
  throw new RefreshTokenReuseDetectedError();
}

async function createRefreshTokenRecord(
  params: RefreshTokenContext & {
    familyId?: string;
    parentTokenId?: string;
    userId: string;
    // Workspace scope carried from the authorization code / prior refresh token (design §7 step
    // 3-4); defaults to null when no workspace was selected.
    orgId?: string | null;
    teamId?: string | null;
  },
  refreshToken: string,
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
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const row = await prisma.refreshToken.create({
    data: {
      tokenHash: hashRefreshToken(refreshToken, sharedSecret),
      familyId: params.familyId ?? generateRefreshTokenFamilyId(),
      parentTokenId: params.parentTokenId,
      userId: params.userId,
      domain: params.domain,
      clientId: params.clientId,
      configUrl: params.configUrl,
      orgId: params.orgId ?? null,
      teamId: params.teamId ?? null,
      expiresAt,
      createdAt: now,
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
  return createRefreshTokenRecord(params, generateRefreshTokenValue(), deps);
}

export async function exchangeRefreshToken(
  params: RefreshTokenContext & {
    refreshToken: string;
  },
  deps?: RefreshTokenDeps,
): Promise<{
  expiresInSeconds: number;
  refreshToken: string;
  replayed: boolean;
  userId: string;
  orgId: string | null;
  teamId: string | null;
}> {
  const prisma = getRefreshTokenPrisma(deps);
  const sharedSecret = getSharedSecret(deps);
  const tokenHash = hashRefreshToken(params.refreshToken, sharedSecret);

  const findTokenRow = () =>
    prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: refreshTokenSelect,
    });
  let row = (await findTokenRow()) as RefreshTokenRow | null;

  if (!row) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
  }

  if (!matchesRefreshTokenContext(row, params)) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
  }

  // The opaque lookup discovers the lock identity. Production callers acquire
  // their user+domain transaction lock here, then this second read observes any
  // rotation that committed while the lock was pending.
  if (deps?.beforeFamilyDecision) {
    await deps.beforeFamilyDecision({
      userId: row.userId,
      domain: row.domain,
      orgId: row.orgId,
      teamId: row.teamId,
    });
    row = (await findTokenRow()) as RefreshTokenRow | null;
    if (!row || !matchesRefreshTokenContext(row, params)) {
      throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
    }
  }

  if (row.replacedByTokenId) {
    return resolveRefreshTokenReplay(
      { ...params, row, sharedSecret },
      {
        beforeRotate: deps?.beforeRotate,
        now: () => nowDate(deps),
        prisma,
        rejectReuse: (reused, rejectedAt) =>
          rejectRefreshTokenReuse(prisma, reused, rejectedAt),
      },
    );
  }

  let decisionNow = nowDate(deps);
  if (row.revokedAt || row.expiresAt.getTime() <= decisionNow.getTime()) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
  }

  // Policy gates run here, after the opaque token and its exact client context
  // have been validated but before any replacement row or mutation is written.
  // Callers that need a policy/rotation atomicity guarantee must pass a Prisma
  // transaction as `prisma` and perform the gate through this hook.
  await deps?.beforeRotate?.({
    userId: row.userId,
    domain: row.domain,
    orgId: row.orgId,
    teamId: row.teamId,
  });
  decisionNow = nowDate(deps);
  if (row.expiresAt.getTime() <= decisionNow.getTime()) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
  }

  // Inherit the original session's TTL so rotated tokens keep the same lifetime.
  const inheritedTtlSeconds = Math.round(
    (row.expiresAt.getTime() - row.createdAt.getTime()) / 1000,
  );
  const refreshTokenTtlSeconds = Math.max(
    inheritedTtlSeconds,
    MIN_INHERITED_REFRESH_TTL_SECONDS,
  );

  const successor = deriveRefreshTokenSuccessor(params.refreshToken, sharedSecret);
  const nextRefreshToken = await createRefreshTokenRecord(
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
    successor,
    {
      ...deps,
      now: () => decisionNow,
      refreshTokenTtlSeconds,
    },
  );

  const rotated = await prisma.refreshToken.updateMany({
    where: {
      id: row.id,
      revokedAt: null,
      replacedByTokenId: null,
      expiresAt: {
        gt: decisionNow,
      },
    },
    data: {
      lastUsedAt: decisionNow,
      revokedAt: decisionNow,
      replacedByTokenId: nextRefreshToken.refreshTokenId,
    },
  });

  if (rotated.count !== 1) {
    return rejectRefreshTokenReuse(prisma, row, decisionNow);
  }

  return {
    userId: row.userId,
    refreshToken: nextRefreshToken.refreshToken,
    expiresInSeconds: nextRefreshToken.expiresInSeconds,
    replayed: false,
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
  const prisma = getRefreshTokenPrisma(deps) as unknown as PrismaClient;
  const sharedSecret = getSharedSecret(deps);
  const tokenHash = hashRefreshToken(params.refreshToken, sharedSecret);

  await runInTransaction(prisma, async (tx) => {
    const findTokenRow = () =>
      tx.refreshToken.findUnique({
        where: { tokenHash },
        select: {
          familyId: true,
          userId: true,
          domain: true,
          clientId: true,
          configUrl: true,
        },
      });
    let row = await findTokenRow();
    if (!row || !matchesRefreshTokenContext(row, params)) return;

    await deps?.beforeFamilyRevocationLock?.();
    await lockRefreshSessionUserDomain(
      { userId: row.userId, domain: row.domain },
      { prisma: tx },
    );
    await deps?.afterFamilyRevocationLock?.(row);
    row = await findTokenRow();
    if (!row || !matchesRefreshTokenContext(row, params)) return;

    const revokedCount = await revokeRefreshTokenFamilyInternal(
      tx,
      row.familyId,
      nowDate(deps),
    );
    if (revokedCount > 0) {
      // Family revocation and the global access-token version change commit together.
      await bumpUserTokenVersion(row.userId, { prisma: tx });
    }
  });
}
