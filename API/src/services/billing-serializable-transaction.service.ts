import { Prisma, type PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';

const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 25;
const MAX_DELAY_MS = 400;

type RetryRuntime = {
  random?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
};

type CreditRetryExhaustedMessage =
  | 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED'
  | 'BILLING_CREDIT_SETTLEMENT_RETRY_EXHAUSTED';

function isRetryableTransactionError(error: unknown): boolean {
  const candidate = error as { code?: unknown; meta?: { code?: unknown } } | null;
  return (
    candidate?.code === 'P2034' || (candidate?.code === 'P2010' && candidate.meta?.code === '40001')
  );
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function fullJitterDelay(retryIndex: number, random: () => number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** retryIndex);
  return Math.floor(random() * ceiling);
}

export async function runBillingSerializableTransaction<T>(
  prisma: Pick<PrismaClient, '$transaction'>,
  transaction: (tx: Prisma.TransactionClient) => Promise<T>,
  retryExhaustedMessage: CreditRetryExhaustedMessage,
  runtime: RetryRuntime = {},
): Promise<T> {
  const random = runtime.random ?? Math.random;
  const sleep = runtime.sleep ?? defaultSleep;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(transaction, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isRetryableTransactionError(error)) throw error;
      if (attempt === MAX_ATTEMPTS - 1) {
        throw new AppError('INTERNAL', 503, retryExhaustedMessage);
      }
      await sleep(fullJitterDelay(attempt, random));
    }
  }

  throw new AppError('INTERNAL', 503, retryExhaustedMessage);
}
