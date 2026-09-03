import { createHmac } from 'node:crypto';

import { Prisma, type PrismaClient, type SigningContinuation } from '@prisma/client';

import { getEnv, requireEnv, type Env } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { lockAuthorizationOriginForDecision } from './authorization-origin-lock.service.js';

export type SigningContinuationCapabilityDeps = {
  env?: Env;
  now?: () => Date;
  prisma?: PrismaClient;
  /** BYPASSRLS client retained for callers that already carry the auth transaction. */
  teamPrisma?: PrismaClient;
  publicBaseUrl?: string;
  sharedSecret?: string;
  afterAuthenticationEpochLock?: () => Promise<void>;
};

function prismaClient(deps?: SigningContinuationCapabilityDeps): PrismaClient {
  return deps?.prisma ?? getAdminPrisma();
}

function currentTime(deps?: SigningContinuationCapabilityDeps): Date {
  return deps?.now?.() ?? new Date();
}

function sharedSecret(deps?: SigningContinuationCapabilityDeps): string {
  return deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
}

function rejectContinuation(): never {
  throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
}

export function hashSigningContinuationToken(token: string, pepper: string): string {
  return createHmac('sha256', pepper)
    .update('uoa-signing-continuation\0', 'utf8')
    .update(token, 'utf8')
    .digest('hex');
}

async function lockContinuation(prisma: PrismaClient, tokenHash: string): Promise<void> {
  await prisma.$executeRaw(
    Prisma.sql`SELECT 1 FROM "signing_continuations" WHERE "token_hash" = ${tokenHash} FOR UPDATE`,
  );
}

export async function requireActiveSigningContinuation(
  params: { signingToken: string; lock?: boolean },
  deps?: SigningContinuationCapabilityDeps & { prisma: PrismaClient },
): Promise<SigningContinuation> {
  const prisma = deps?.prisma ?? prismaClient(deps);
  const env = deps?.env ?? getEnv();
  const now = currentTime(deps);
  const tokenHash = hashSigningContinuationToken(params.signingToken, sharedSecret(deps));
  if (params.lock) await lockContinuation(prisma, tokenHash);
  const continuation = await prisma.signingContinuation.findUnique({ where: { tokenHash } });
  if (
    !continuation ||
    continuation.consumedAt ||
    continuation.expiresAt.getTime() <= now.getTime() ||
    continuation.attemptCount >= env.SIGNATURE_MAX_SIGN_ATTEMPTS
  ) {
    return rejectContinuation();
  }
  return continuation;
}

function requireCredentialEpoch(continuation: SigningContinuation): number {
  if (
    continuation.tokenVersion === null ||
    !Number.isSafeInteger(continuation.tokenVersion) ||
    continuation.tokenVersion < 0
  ) {
    return rejectContinuation();
  }
  return continuation.tokenVersion;
}

function sameOrigin(left: SigningContinuation, right: SigningContinuation): boolean {
  return (
    left.id === right.id &&
    left.userId === right.userId &&
    left.domain === right.domain &&
    left.authProfile === right.authProfile &&
    left.configUrl === right.configUrl &&
    left.oauthClientId === right.oauthClientId &&
    left.redirectUrl === right.redirectUrl &&
    left.orgId === right.orgId &&
    left.teamId === right.teamId &&
    left.authMethod === right.authMethod &&
    left.twoFaCompleted === right.twoFaCompleted &&
    left.tokenVersion === right.tokenVersion &&
    left.expiresAt.getTime() === right.expiresAt.getTime()
  );
}

/**
 * Discover the opaque capability without locking, then take the canonical product → user →
 * team → signature hierarchy before locking and re-reading the continuation itself.
 */
export async function lockAndRequireSigningContinuationForDecision(
  signingToken: string,
  deps: SigningContinuationCapabilityDeps & { prisma: PrismaClient },
): Promise<SigningContinuation> {
  const preview = await requireActiveSigningContinuation({ signingToken }, deps);
  const credentialEpoch = requireCredentialEpoch(preview);
  await lockAuthorizationOriginForDecision(
    {
      userId: preview.userId,
      domain: preview.domain,
      credentialEpoch,
      profile: preview.authProfile,
      orgId: preview.orgId,
      teamId: preview.teamId,
    },
    {
      prisma: deps.prisma,
      afterAuthenticationEpochLock: deps.afterAuthenticationEpochLock,
      crossProductPrisma: deps.prisma,
      policyPrisma: deps.prisma,
    },
  );
  const current = await requireActiveSigningContinuation({ signingToken, lock: true }, deps);
  if (!sameOrigin(preview, current)) return rejectContinuation();
  requireCredentialEpoch(current);
  return current;
}

/**
 * Authenticate a continuation-backed read at one credential-epoch linearization point. The
 * callback may read database metadata while the canonical locks are held; object storage remains
 * outside it so private I/O cannot lengthen the database transaction.
 */
export async function withEpochValidSigningContinuationRead<T>(
  signingToken: string,
  read: (continuation: SigningContinuation, prisma: PrismaClient) => Promise<T>,
  deps?: SigningContinuationCapabilityDeps,
): Promise<T> {
  const prisma = prismaClient(deps);
  return runInTransaction(prisma, async (tx) => {
    const continuation = await lockAndRequireSigningContinuationForDecision(signingToken, {
      ...deps,
      prisma: tx,
    });
    return read(continuation, tx);
  });
}

export async function recordSigningContinuationFailure(
  continuationId: string,
  deps?: SigningContinuationCapabilityDeps & { prisma: PrismaClient },
): Promise<void> {
  const prisma = deps?.prisma ?? prismaClient(deps);
  await prisma.signingContinuation.updateMany({
    where: { id: continuationId, consumedAt: null },
    data: { attemptCount: { increment: 1 } },
  });
}
