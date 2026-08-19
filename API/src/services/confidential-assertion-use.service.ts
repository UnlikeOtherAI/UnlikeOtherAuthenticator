import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

export const CONFIDENTIAL_ASSERTION_CLOCK_TOLERANCE_SECONDS = 5;

// The assertion verifier accepts a token until exp plus clock tolerance, so
// the ledger row must strictly outlive that instant; otherwise a replay can
// find the jti already pruned while jose would still accept the assertion.
export const CONFIDENTIAL_ASSERTION_LEDGER_RETENTION_MARGIN_SECONDS = 1;

type AssertionUsePrisma = Pick<PrismaClient, 'confidentialAssertionUse'>;

type ConsumeAssertionDeps = {
  now?: () => Date;
  prisma?: AssertionUsePrisma;
};

function invalidSubjectToken(): AppError {
  return new AppError('UNAUTHORIZED', 401, 'INVALID_SUBJECT_TOKEN');
}

function hashAssertionJti(sourceDomain: string, jti: string): string {
  return createHash('sha256')
    .update(sourceDomain, 'utf8')
    .update('\0', 'utf8')
    .update(jti, 'utf8')
    .digest('hex');
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2002';
}

/**
 * Atomically claims a verified confidential assertion for one-time use.
 *
 * The unique insert is the cross-process serialization point. An expired row
 * with the same source+jti may be removed first, but only once it sits at exp
 * plus clock tolerance plus the retention margin, so the ledger always
 * outlives the last instant the assertion verifier accepts a replay. If two
 * callers race to replace or create a row, the unique constraint still allows
 * exactly one.
 */
export async function consumeConfidentialAssertion(
  params: {
    expiresAtEpochSeconds: number;
    jti: string;
    sourceDomain: string;
  },
  deps: ConsumeAssertionDeps = {},
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const expiresAt = new Date(
    (params.expiresAtEpochSeconds +
      CONFIDENTIAL_ASSERTION_CLOCK_TOLERANCE_SECONDS +
      CONFIDENTIAL_ASSERTION_LEDGER_RETENTION_MARGIN_SECONDS) *
      1000,
  );
  if (
    !params.sourceDomain ||
    !params.jti ||
    !Number.isSafeInteger(params.expiresAtEpochSeconds) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= now.getTime()
  ) {
    throw invalidSubjectToken();
  }

  const prisma = deps.prisma ?? getAdminPrisma();
  const jtiHash = hashAssertionJti(params.sourceDomain, params.jti);

  await prisma.confidentialAssertionUse.deleteMany({
    where: {
      sourceDomain: params.sourceDomain,
      jtiHash,
      expiresAt: { lte: now },
    },
  });

  try {
    await prisma.confidentialAssertionUse.create({
      data: {
        sourceDomain: params.sourceDomain,
        jtiHash,
        expiresAt,
      },
      select: { id: true },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw invalidSubjectToken();
    }
    throw error;
  }
}
