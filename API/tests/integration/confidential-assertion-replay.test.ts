import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { consumeConfidentialAssertion } from '../../src/services/confidential-assertion-use.service.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)('confidential assertion replay persistence', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  let secondPrisma: PrismaClient;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    secondPrisma = new PrismaClient({
      datasources: { db: { url: handle.databaseUrl } },
    });
    await secondPrisma.$connect();
  });

  afterAll(async () => {
    await secondPrisma?.$disconnect();
    await handle?.cleanup();
  });

  beforeEach(async () => {
    await handle!.prisma.confidentialAssertionUse.deleteMany();
  });

  it('allows exactly one concurrent claim across independent database clients', async () => {
    const now = new Date('2026-07-19T12:00:00.000Z');
    const params = {
      expiresAtEpochSeconds: Math.floor(now.getTime() / 1000) + 60,
      jti: 'concurrent-one-time-jti',
      sourceDomain: 'api.nessie.works',
    };

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        consumeConfidentialAssertion(params, {
          prisma: index % 2 === 0 ? handle!.prisma : secondPrisma,
          now: () => now,
        }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(19);
    for (const result of rejected) {
      expect(result.reason).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'INVALID_SUBJECT_TOKEN',
      });
    }
    expect(await handle!.prisma.confidentialAssertionUse.count()).toBe(1);

    await expect(
      consumeConfidentialAssertion(
        { ...params, jti: 'fresh-jti' },
        { prisma: secondPrisma, now: () => now },
      ),
    ).resolves.toBeUndefined();
    expect(await handle!.prisma.confidentialAssertionUse.count()).toBe(2);
  });

  it('permits jti reuse only after the prior accepted expiry window', async () => {
    const firstNow = new Date('2026-07-19T12:00:00.000Z');
    const firstExpiry = Math.floor(firstNow.getTime() / 1000) + 10;
    const params = {
      expiresAtEpochSeconds: firstExpiry,
      jti: 'issuer-reused-jti',
      sourceDomain: 'api.nessie.works',
    };

    await consumeConfidentialAssertion(params, {
      prisma: handle!.prisma,
      now: () => firstNow,
    });
    await expect(
      consumeConfidentialAssertion(params, {
        prisma: secondPrisma,
        now: () => new Date(firstNow.getTime() + 14_000),
      }),
    ).rejects.toThrow('INVALID_SUBJECT_TOKEN');

    const afterAcceptedExpiry = new Date(firstNow.getTime() + 16_000);
    await expect(
      consumeConfidentialAssertion(
        {
          ...params,
          expiresAtEpochSeconds: Math.floor(afterAcceptedExpiry.getTime() / 1000) + 60,
        },
        {
          prisma: secondPrisma,
          now: () => afterAcceptedExpiry,
        },
      ),
    ).resolves.toBeUndefined();
    expect(await handle!.prisma.confidentialAssertionUse.count()).toBe(1);
  });
});
