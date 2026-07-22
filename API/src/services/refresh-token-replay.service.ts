import { createHmac } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';

const REFRESH_SUCCESSOR_HMAC_DOMAIN = 'uoa.refresh-token.successor.v1\0';
const MAX_REFRESH_REPLAY_CHAIN_DEPTH = 32;

/**
 * A short exact-context window lets a product recover when UOA rotated a
 * refresh token but the successful HTTP response was lost. Outside this
 * window, predecessor use is treated as theft.
 */
export const REFRESH_TOKEN_REPLAY_GRACE_MS = 120_000;

export type RefreshTokenContext = {
  clientId: string;
  configUrl: string;
  domain: string;
};

export type RefreshTokenRow = {
  id: string;
  tokenHash: string;
  familyId: string;
  parentTokenId: string | null;
  userId: string;
  domain: string;
  clientId: string;
  configUrl: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedByTokenId: string | null;
  orgId: string | null;
  teamId: string | null;
};

type ReplayPrisma = Pick<PrismaClient, 'refreshToken'>;

export const refreshTokenSelect = {
  id: true,
  tokenHash: true,
  familyId: true,
  parentTokenId: true,
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
} as const;

export function hashRefreshToken(token: string, pepper: string): string {
  return createHmac('sha256', pepper).update(token, 'utf8').digest('hex');
}

export function deriveRefreshTokenSuccessor(token: string, pepper: string): string {
  return createHmac('sha256', pepper)
    .update(REFRESH_SUCCESSOR_HMAC_DOMAIN, 'utf8')
    .update(token, 'utf8')
    .digest('base64url');
}

export function matchesRefreshTokenContext(
  row: RefreshTokenContext,
  context: RefreshTokenContext,
): boolean {
  return (
    row.clientId === context.clientId &&
    row.configUrl === context.configUrl &&
    row.domain === context.domain
  );
}

function sameRefreshTokenFamily(left: RefreshTokenRow, right: RefreshTokenRow): boolean {
  return (
    left.familyId === right.familyId &&
    left.userId === right.userId &&
    left.domain === right.domain &&
    left.clientId === right.clientId &&
    left.configUrl === right.configUrl &&
    left.orgId === right.orgId &&
    left.teamId === right.teamId
  );
}

function remainingRefreshTokenTtlSeconds(row: RefreshTokenRow, now: Date): number {
  return Math.max(0, Math.floor((row.expiresAt.getTime() - now.getTime()) / 1000));
}

export async function resolveRefreshTokenReplay(
  params: RefreshTokenContext & {
    refreshToken: string;
    row: RefreshTokenRow;
    sharedSecret: string;
  },
  deps: {
    beforeRotate?: (row: {
      userId: string;
      domain: string;
      orgId: string | null;
      teamId: string | null;
    }) => Promise<void>;
    now: () => Date;
    prisma: ReplayPrisma;
    rejectReuse: (row: RefreshTokenRow, now: Date) => Promise<never>;
  },
): Promise<{
  expiresInSeconds: number;
  refreshToken: string;
  replayed: true;
  userId: string;
  orgId: string | null;
  teamId: string | null;
}> {
  const firstDecisionAt = deps.now();
  if (
    !params.row.revokedAt ||
    firstDecisionAt.getTime() - params.row.revokedAt.getTime() > REFRESH_TOKEN_REPLAY_GRACE_MS
  ) {
    return deps.rejectReuse(params.row, firstDecisionAt);
  }

  let current = params.row;
  let currentRawToken = params.refreshToken;
  const seen = new Set([current.id]);
  let depth = 0;

  while (current.replacedByTokenId) {
    if (depth >= MAX_REFRESH_REPLAY_CHAIN_DEPTH || seen.has(current.replacedByTokenId)) {
      return deps.rejectReuse(params.row, deps.now());
    }
    depth += 1;
    const successorRawToken = deriveRefreshTokenSuccessor(
      currentRawToken,
      params.sharedSecret,
    );
    const successor = (await deps.prisma.refreshToken.findUnique({
      where: { id: current.replacedByTokenId },
      select: refreshTokenSelect,
    })) as RefreshTokenRow | null;
    if (
      !successor ||
      successor.parentTokenId !== current.id ||
      successor.tokenHash !== hashRefreshToken(successorRawToken, params.sharedSecret) ||
      !sameRefreshTokenFamily(params.row, successor) ||
      !matchesRefreshTokenContext(successor, params)
    ) {
      return deps.rejectReuse(params.row, deps.now());
    }
    seen.add(successor.id);
    current = successor;
    currentRawToken = successorRawToken;
  }

  if (current.revokedAt) {
    return deps.rejectReuse(params.row, deps.now());
  }

  await deps.beforeRotate?.({
    userId: current.userId,
    domain: current.domain,
    orgId: current.orgId,
    teamId: current.teamId,
  });
  const finalDecisionAt = deps.now();
  if (
    !params.row.revokedAt ||
    finalDecisionAt.getTime() - params.row.revokedAt.getTime() > REFRESH_TOKEN_REPLAY_GRACE_MS
  ) {
    return deps.rejectReuse(params.row, finalDecisionAt);
  }
  if (current.expiresAt.getTime() <= finalDecisionAt.getTime()) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
  }

  return {
    userId: current.userId,
    refreshToken: currentRawToken,
    expiresInSeconds: remainingRefreshTokenTtlSeconds(current, finalDecisionAt),
    replayed: true,
    orgId: current.orgId,
    teamId: current.teamId,
  };
}
