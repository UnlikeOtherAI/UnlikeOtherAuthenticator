import type { Prisma, PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { guardPoolCheckouts } from '../pool-checkout-guard.js';
import { runInTransaction } from '../tenant-context.js';

type InteractiveFn = (tx: Prisma.TransactionClient) => Promise<unknown>;

/**
 * A stand-in for a generated PrismaClient: one model delegate (`user` is a real
 * `Prisma.ModelName`), the raw-query methods, lifecycle methods that must pass
 * through, and a `$transaction` that hands the interactive body its own `tx`.
 */
function fakeClient() {
  const tx = { user: { findMany: vi.fn(async () => ['from-tx']) } };
  const raw = {
    user: { findMany: vi.fn(async () => ['from-global']) },
    $queryRaw: vi.fn(async () => []),
    $executeRawUnsafe: vi.fn(async () => 1),
    $connect: vi.fn(async () => undefined),
    $on: vi.fn(),
    $transaction: vi.fn(async (arg: unknown, _options?: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as InteractiveFn)(tx as never),
    ),
  };
  return { raw, tx, client: raw as unknown as PrismaClient };
}

const nestedAdmin = /Nested admin-pool checkout.*use the transaction client/;

describe('guardPoolCheckouts', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
  });

  it('throws in test mode when the global client of the same pool is used inside its transaction', async () => {
    const admin = guardPoolCheckouts(fakeClient().client, 'admin');

    await expect(
      admin.$transaction(async () => {
        await admin.user.findMany();
      }),
    ).rejects.toThrow(nestedAdmin);
  });

  it('flags raw queries and nested $transaction on the same pool too', async () => {
    const admin = guardPoolCheckouts(fakeClient().client, 'admin');

    await expect(admin.$transaction(() => admin.$queryRaw`SELECT 1`)).rejects.toThrow(nestedAdmin);
    await expect(admin.$transaction(() => admin.$executeRawUnsafe('SELECT 1'))).rejects.toThrow(
      nestedAdmin,
    );
    await expect(
      admin.$transaction(() => admin.$transaction(async () => undefined)),
    ).rejects.toThrow(nestedAdmin);
  });

  it('lets the transaction client be used freely inside the transaction', async () => {
    const { client, tx } = fakeClient();
    const admin = guardPoolCheckouts(client, 'admin');

    const result = await admin.$transaction(async (handed) => {
      expect(handed).toBe(tx);
      return handed.user.findMany();
    });

    expect(result).toEqual(['from-tx']);
  });

  it('does not flag the other pool inside a transaction', async () => {
    const admin = guardPoolCheckouts(fakeClient().client, 'admin');
    const app = guardPoolCheckouts(fakeClient().client, 'app');

    await expect(
      app.$transaction(async () => admin.user.findMany()),
    ).resolves.toEqual(['from-global']);
  });

  it('keeps the outer pool flagged inside a nested cross-pool transaction', async () => {
    const admin = guardPoolCheckouts(fakeClient().client, 'admin');
    const app = guardPoolCheckouts(fakeClient().client, 'app');

    await expect(
      admin.$transaction(() => app.$transaction(() => admin.user.findMany())),
    ).rejects.toThrow(nestedAdmin);
  });

  it('allows the global client again once the transaction has settled', async () => {
    const admin = guardPoolCheckouts(fakeClient().client, 'admin');

    await admin.$transaction(async () => 'done');
    await expect(admin.user.findMany()).resolves.toEqual(['from-global']);
  });

  it('does not flag detached work that outlives the transaction', async () => {
    const admin = guardPoolCheckouts(fakeClient().client, 'admin');
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });

    let detached!: Promise<unknown>;
    await admin.$transaction(async () => {
      detached = settled.then(() => admin.user.findMany());
    });
    release();

    await expect(detached).resolves.toEqual(['from-global']);
  });

  it('releases the marker when the transaction body rejects', async () => {
    const admin = guardPoolCheckouts(fakeClient().client, 'admin');

    await expect(admin.$transaction(async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await expect(admin.user.findMany()).resolves.toEqual(['from-global']);
  });

  it('passes the batch form through untouched', async () => {
    const { client, raw } = fakeClient();
    const admin = guardPoolCheckouts(client, 'admin');
    const batch = [Promise.resolve(1), Promise.resolve(2)];

    await expect(admin.$transaction(batch as never)).resolves.toEqual([1, 2]);
    expect(raw.$transaction).toHaveBeenCalledWith(batch);
  });

  it('forwards transaction options to the underlying client', async () => {
    const { client, raw } = fakeClient();
    const admin = guardPoolCheckouts(client, 'admin');

    await admin.$transaction(async () => undefined, { timeout: 1234 });

    expect(raw.$transaction.mock.calls[0][1]).toEqual({ timeout: 1234 });
  });

  it('leaves lifecycle methods, unknown properties and symbols untouched', async () => {
    const { client, raw } = fakeClient();
    const admin = guardPoolCheckouts(client, 'admin');

    await admin.$transaction(async () => {
      await admin.$connect();
      admin.$on('query' as never, () => undefined);
      expect((admin as unknown as { then?: unknown }).then).toBeUndefined();
      expect((admin as unknown as Record<symbol, unknown>)[Symbol.toStringTag]).toBeUndefined();
    });

    expect(raw.$connect).toHaveBeenCalledTimes(1);
    expect(raw.$on).toHaveBeenCalledTimes(1);
  });

  it('covers runInTransaction, which opens the transaction on whatever client it is given', async () => {
    const admin = guardPoolCheckouts(fakeClient().client, 'admin');

    await expect(runInTransaction(admin, () => admin.user.findMany())).rejects.toThrow(nestedAdmin);
    await expect(runInTransaction(admin, (tx) => tx.user.findMany())).resolves.toEqual(['from-tx']);
  });

  it('logs once per call site instead of throwing outside test mode', async () => {
    process.env.NODE_ENV = 'production';
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const admin = guardPoolCheckouts(fakeClient().client, 'admin');

    const violate = () => admin.$transaction(() => admin.user.findMany());
    await expect(violate()).resolves.toEqual(['from-global']);
    await expect(violate()).resolves.toEqual(['from-global']);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe('[db:pool-checkout]');
    expect(error.mock.calls[0][1]).toMatch(nestedAdmin);
  });
});
