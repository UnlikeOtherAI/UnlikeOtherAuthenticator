import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';

type LoginSessionUsePrisma = Pick<PrismaClient, 'loginSessionUse'>;

function rejectLoginSession(): never {
  throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
}

function hashLoginSessionJti(domain: string, jti: string): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(jti, 'utf8')
    .digest('hex');
}

/**
 * Claim a verified chooser capability exactly once. The unique insert is the
 * cross-process serialization point and belongs in the same transaction as
 * workspace mutation and final authorization issuance.
 */
export async function consumeLoginSession(
  params: {
    domain: string;
    jti: string;
    expiresAtEpochSeconds: number;
    prisma: LoginSessionUsePrisma;
    now?: Date;
  },
): Promise<void> {
  const now = params.now ?? new Date();
  const expiresAt = new Date(params.expiresAtEpochSeconds * 1000);
  if (
    !params.domain ||
    !params.jti ||
    !Number.isSafeInteger(params.expiresAtEpochSeconds) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= now.getTime()
  ) {
    rejectLoginSession();
  }

  try {
    await params.prisma.loginSessionUse.create({
      data: {
        domain: params.domain,
        jtiHash: hashLoginSessionJti(params.domain, params.jti),
        expiresAt,
      },
      select: { id: true },
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'P2002') {
      rejectLoginSession();
    }
    throw error;
  }
}
