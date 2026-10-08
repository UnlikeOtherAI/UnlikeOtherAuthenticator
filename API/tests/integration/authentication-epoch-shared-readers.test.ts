import { randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { lockAndAssertAuthenticationEpochShared } from '../../src/services/authentication-epoch.service.js';
import { revokeAllRefreshTokensForUser } from '../../src/services/refresh-token-revocation.service.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled = Boolean(process.env.DATABASE_URL);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe.skipIf(!enabled)('shared authentication epoch reads', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  let db: PrismaClient;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalAdminDatabaseUrl = process.env.DATABASE_ADMIN_URL;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    db = handle.prisma;
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.DATABASE_ADMIN_URL = originalAdminDatabaseUrl;
    if (handle) await handle.cleanup();
  });

  it('overlaps read assertions but waits for the exclusive epoch writer', async () => {
    const userId = `epoch-reader-${randomUUID()}`;
    const domain = 'shared-reader.example';
    const email = `${userId}@example.com`;
    await db.user.create({ data: { id: userId, email, userKey: email } });

    const firstEntered = deferred();
    const secondEntered = deferred();
    const releaseReaders = deferred();
    const reader = (entered: ReturnType<typeof deferred>) => db.$transaction(async (tx) => {
      await lockAndAssertAuthenticationEpochShared({ userId, domain, credentialEpoch: 0 }, {
        prisma: tx,
        afterLock: async () => {
          entered.resolve();
          await releaseReaders.promise;
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 });

    const first = reader(firstEntered);
    await firstEntered.promise;
    const second = reader(secondEntered);
    let revokeAcquired = false;
    const releaseRevocation = deferred();
    let revocation: Promise<void> | undefined;

    try {
      let overlapTimeout: NodeJS.Timeout | undefined;
      const readersOverlapped = await Promise.race([
        secondEntered.promise.then(() => true),
        new Promise<boolean>((resolve) => {
          overlapTimeout = setTimeout(() => resolve(false), 1_000);
        }),
      ]);
      if (overlapTimeout) clearTimeout(overlapTimeout);
      expect(readersOverlapped).toBe(true);

      const revocationEntered = deferred();
      revocation = revokeAllRefreshTokensForUser(userId, {
        prisma: db,
        afterUserLock: async () => {
          revokeAcquired = true;
          revocationEntered.resolve();
          await releaseRevocation.promise;
        },
      });
      expect(revokeAcquired).toBe(false);
      releaseReaders.resolve();
      await Promise.all([first, second]);
      await revocationEntered.promise;
      expect(revokeAcquired).toBe(true);
    } finally {
      releaseReaders.resolve();
      releaseRevocation.resolve();
      await Promise.allSettled([first, second]);
    }

    await revocation;
    await expect(db.$transaction((tx) => lockAndAssertAuthenticationEpochShared({
      userId, domain, credentialEpoch: 0,
    }, { prisma: tx }))).rejects.toMatchObject({ statusCode: 401 });
  });
});
