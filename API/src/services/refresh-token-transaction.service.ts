import type { PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { isRefreshTokenReuseDetectedError } from './refresh-token.service.js';

type RefreshTransactionOutcome<T> =
  | { kind: 'issued'; value: T }
  | { kind: 'reuse_revoked' };

async function captureReuseRevocation<T>(
  prisma: PrismaClient,
  exchange: (tx: PrismaClient) => Promise<T>,
): Promise<RefreshTransactionOutcome<T>> {
  try {
    return { kind: 'issued', value: await exchange(prisma) };
  } catch (error) {
    if (isRefreshTokenReuseDetectedError(error)) return { kind: 'reuse_revoked' };
    throw error;
  }
}

/** Commit theft-triggered family revocation, then surface the same opaque 401 as every rejection. */
export async function runRefreshTokenExchangeTransaction<T>(
  prisma: PrismaClient,
  exchange: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  const outcome =
    typeof prisma.$transaction === 'function'
      ? await prisma.$transaction((tx) =>
          captureReuseRevocation(tx as unknown as PrismaClient, exchange),
        )
      : await captureReuseRevocation(prisma, exchange);

  if (outcome.kind === 'reuse_revoked') {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
  }
  return outcome.value;
}
