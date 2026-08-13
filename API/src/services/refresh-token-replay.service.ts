import { createHmac } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { AppError, isAppError } from '../utils/errors.js';

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
  securityRevokedAt: Date | null;
  replacedByTokenId: string | null;
  orgId: string | null;
  teamId: string | null;
  twoFaCompleted: boolean;
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
  securityRevokedAt: true,
  replacedByTokenId: true,
  orgId: true,
  teamId: true,
  twoFaCompleted: true,
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
    (left.twoFaCompleted === true) === (right.twoFaCompleted === true)
  );
}

function hasValidWorkspaceScope(row: Pick<RefreshTokenRow, 'orgId' | 'teamId'>): boolean {
  return Boolean(row.orgId) === Boolean(row.teamId);
}

function matchesWorkspaceScope(
  row: Pick<RefreshTokenRow, 'orgId' | 'teamId'>,
  expected: { orgId: string | null; teamId: string | null },
): boolean {
  return row.orgId === expected.orgId && row.teamId === expected.teamId;
}

function remainingRefreshTokenTtlSeconds(row: RefreshTokenRow, now: Date): number {
  return Math.max(1, Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1000));
}

export async function resolveRefreshTokenReplay(
  params: RefreshTokenContext & {
    refreshToken: string;
    row: RefreshTokenRow;
    sharedSecret: string;
    expectedWorkspace: { orgId: string | null; teamId: string | null };
    workspaceSwitch: boolean;
  },
  deps: {
    beforeRotate?: (row: {
      userId: string;
      domain: string;
      orgId: string | null;
      teamId: string | null;
      twoFaCompleted: boolean;
    }) => Promise<void>;
    now: () => Date;
    prisma: ReplayPrisma;
    rejectCorruption: (row: RefreshTokenRow, now: Date) => Promise<never>;
    retireFamily: (row: RefreshTokenRow, now: Date) => Promise<never>;
    rejectReuse: (row: RefreshTokenRow, now: Date) => Promise<never>;
  },
): Promise<{
  expiresInSeconds: number;
  refreshToken: string;
  replayed: true;
  userId: string;
  orgId: string | null;
  teamId: string | null;
  twoFaCompleted: boolean;
}> {
  const firstDecisionAt = deps.now();
  if (!hasValidWorkspaceScope(params.row)) {
    return deps.rejectCorruption(params.row, firstDecisionAt);
  }
  let current = params.row;
  let currentRawToken = params.refreshToken;
  let workspaceConflict = false;
  const seen = new Set([current.id]);
  let depth = 0;

  while (current.replacedByTokenId) {
    if (depth >= MAX_REFRESH_REPLAY_CHAIN_DEPTH) {
      // Rotation count is unbounded, so reaching the defensive traversal limit does not prove
      // structural corruption. Retire only the verified root family; cycles and invalid edges
      // below still fail closed across all refresh state for the user.
      return deps.rejectReuse(params.row, deps.now());
    }
    if (seen.has(current.replacedByTokenId)) {
      return deps.rejectCorruption(params.row, deps.now());
    }
    depth += 1;
    const successorRawToken = deriveRefreshTokenSuccessor(currentRawToken, params.sharedSecret);
    const successor = (await deps.prisma.refreshToken.findUnique({
      where: { id: current.replacedByTokenId },
      select: refreshTokenSelect,
    })) as RefreshTokenRow | null;
    if (
      !successor ||
      successor.parentTokenId !== current.id ||
      successor.tokenHash !== hashRefreshToken(successorRawToken, params.sharedSecret) ||
      !sameRefreshTokenFamily(params.row, successor) ||
      !matchesRefreshTokenContext(successor, params) ||
      !hasValidWorkspaceScope(successor)
    ) {
      return deps.rejectCorruption(params.row, deps.now());
    }
    if (!matchesWorkspaceScope(successor, params.expectedWorkspace)) {
      workspaceConflict = true;
    }
    seen.add(successor.id);
    current = successor;
    currentRawToken = successorRawToken;
  }

  // Always establish that the stored deterministic chain is structurally sound before deciding
  // ordinary post-grace reuse. A detached corrupt successor cannot escape a family-only revoke.
  if (
    !params.row.revokedAt ||
    firstDecisionAt.getTime() - params.row.revokedAt.getTime() > REFRESH_TOKEN_REPLAY_GRACE_MS
  ) {
    return deps.rejectReuse(params.row, firstDecisionAt);
  }
  if (current.revokedAt) {
    // A lifecycle writer, explicit logout, or committed-edge policy retirement may revoke the
    // live descendant while a legitimate response-loss retry is still inside grace. Return no
    // token, but do not reclassify that retry as theft; post-grace predecessor use is handled
    // above and still performs the one-time security invalidation.
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
  }
  if (workspaceConflict) {
    throw new AppError('BAD_REQUEST', 409, 'WORKSPACE_SWITCH_CONFLICT');
  }
  if (params.workspaceSwitch && matchesWorkspaceScope(params.row, params.expectedWorkspace)) {
    // Classify this as a semantic no-op only after proving the deterministic
    // successor chain is structurally valid. A corrupt chain is still reuse.
    throw new AppError('BAD_REQUEST', 409, 'WORKSPACE_SWITCH_CONFLICT');
  }

  try {
    await deps.beforeRotate?.({
      userId: current.userId,
      domain: current.domain,
      orgId: current.orgId,
      teamId: current.teamId,
      twoFaCompleted: current.twoFaCompleted === true,
    });
  } catch (error) {
    const rejectedAt = deps.now();
    if (
      !params.row.revokedAt ||
      rejectedAt.getTime() - params.row.revokedAt.getTime() > REFRESH_TOKEN_REPLAY_GRACE_MS
    ) {
      return deps.rejectReuse(params.row, rejectedAt);
    }
    if (
      params.workspaceSwitch &&
      isAppError(error) &&
      (error.statusCode === 401 || error.statusCode === 403)
    ) {
      // The switch edge already committed, so a pre-edge 403 would strand a caller that lost the
      // response. Retire this now-unusable family and return one definitive authenticated 401.
      return deps.retireFamily(params.row, rejectedAt);
    }
    throw error;
  }
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
    twoFaCompleted: current.twoFaCompleted === true,
  };
}
