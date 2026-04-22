import type { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { runWithTenantContext } from '../tenant-context.js';

type MockTx = {
  $executeRaw: ReturnType<typeof vi.fn>;
};

function makePrismaMock(): {
  prisma: PrismaClient;
  tx: MockTx;
  transactionSpy: ReturnType<typeof vi.fn>;
} {
  const tx: MockTx = { $executeRaw: vi.fn(async () => 1) };
  const transactionSpy = vi.fn(
    async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      run(tx as unknown as Prisma.TransactionClient),
  );
  const prisma = { $transaction: transactionSpy } as unknown as PrismaClient;
  return { prisma, tx, transactionSpy };
}

describe('runWithTenantContext', () => {
  it('opens a transaction and sets all three session variables', async () => {
    const { prisma, tx, transactionSpy } = makePrismaMock();
    const handler = vi.fn(async () => 'ok');

    const result = await runWithTenantContext(
      { prisma, context: { domain: 'app.example.com', orgId: 'org-1', userId: 'user-1' } },
      handler,
    );

    expect(result).toBe('ok');
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(tx);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);

    const [strings, ...values] = tx.$executeRaw.mock.calls[0];
    expect(strings.join('?')).toContain("set_config('app.domain',");
    expect(strings.join('?')).toContain("set_config('app.org_id',");
    expect(strings.join('?')).toContain("set_config('app.user_id',");
    expect(values).toEqual(['app.example.com', 'org-1', 'user-1']);
  });

  it('coalesces missing orgId and userId to empty strings', async () => {
    const { prisma, tx } = makePrismaMock();

    await runWithTenantContext(
      { prisma, context: { domain: 'app.example.com' } },
      async () => null,
    );

    const [, ...values] = tx.$executeRaw.mock.calls[0];
    expect(values).toEqual(['app.example.com', '', '']);
  });

  it('passes the transaction client through to the handler', async () => {
    const { prisma, tx } = makePrismaMock();

    const received = await runWithTenantContext(
      { prisma, context: { domain: 'a' } },
      async (inner) => inner,
    );

    expect(received).toBe(tx);
  });
});
