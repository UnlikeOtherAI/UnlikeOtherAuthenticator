import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { runBillingSerializableTransaction } from '../../src/services/billing-serializable-transaction.service.js';

type TransactionRunner = Parameters<typeof runBillingSerializableTransaction>[0];

function runner(transaction: ReturnType<typeof vi.fn>): TransactionRunner {
  return { $transaction: transaction } as unknown as TransactionRunner;
}

describe('billing serializable transaction retries', () => {
  it('retries serialization conflicts with exponential full jitter', async () => {
    const operation = vi.fn(async () => 'settled');
    let attempts = 0;
    const transaction = vi.fn(
      async (
        callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options: { isolationLevel: Prisma.TransactionIsolationLevel },
      ) => {
        attempts += 1;
        expect(options).toEqual({
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
        if (attempts <= 2) throw { code: 'P2034' };
        return callback({} as Prisma.TransactionClient);
      },
    );
    const sleep = vi.fn(async () => undefined);

    await expect(
      runBillingSerializableTransaction(
        runner(transaction),
        operation,
        'BILLING_CREDIT_SETTLEMENT_RETRY_EXHAUSTED',
        { random: () => 0.5, sleep },
      ),
    ).resolves.toBe('settled');

    expect(transaction).toHaveBeenCalledTimes(3);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([12, 25]);
  });

  it('recognizes a raw PostgreSQL serialization failure from Prisma', async () => {
    let attempts = 0;
    const transaction = vi.fn(
      async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        attempts += 1;
        if (attempts === 1) throw { code: 'P2010', meta: { code: '40001' } };
        return callback({} as Prisma.TransactionClient);
      },
    );

    await expect(
      runBillingSerializableTransaction(
        runner(transaction),
        async () => 'recovered',
        'BILLING_CREDIT_SETTLEMENT_RETRY_EXHAUSTED',
        { random: () => 0, sleep: async () => undefined },
      ),
    ).resolves.toBe('recovered');
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it.each([
    'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED',
    'BILLING_CREDIT_SETTLEMENT_RETRY_EXHAUSTED',
  ] as const)('returns a stable 503 for %s', async (retryExhaustedMessage) => {
    const transaction = vi.fn(async () => {
      throw { code: 'P2034' };
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      runBillingSerializableTransaction(
        runner(transaction),
        async () => undefined,
        retryExhaustedMessage,
        { random: () => 0, sleep },
      ),
    ).rejects.toMatchObject({
      code: 'INTERNAL',
      statusCode: 503,
      message: retryExhaustedMessage,
    });
    expect(transaction).toHaveBeenCalledTimes(8);
    expect(sleep).toHaveBeenCalledTimes(7);
  });

  it('does not retry a non-serialization failure', async () => {
    const failure = new Error('query failed');
    const transaction = vi.fn(async () => {
      throw failure;
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      runBillingSerializableTransaction(
        runner(transaction),
        async () => undefined,
        'BILLING_CREDIT_SETTLEMENT_RETRY_EXHAUSTED',
        { random: () => 0, sleep },
      ),
    ).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
