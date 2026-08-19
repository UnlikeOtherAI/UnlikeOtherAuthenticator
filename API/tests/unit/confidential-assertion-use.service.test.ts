import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  CONFIDENTIAL_ASSERTION_CLOCK_TOLERANCE_SECONDS,
  CONFIDENTIAL_ASSERTION_LEDGER_RETENTION_MARGIN_SECONDS,
  consumeConfidentialAssertion,
} from '../../src/services/confidential-assertion-use.service.js';

function prismaMock(options?: { duplicate?: boolean }): PrismaClient {
  return {
    confidentialAssertionUse: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: options?.duplicate
        ? vi.fn().mockRejectedValue({ code: 'P2002' })
        : vi.fn().mockResolvedValue({ id: 'use-1' }),
    },
  } as unknown as PrismaClient;
}

/**
 * In-memory ledger with the real deleteMany-then-unique-create semantics, so a
 * consume followed by a replay exercises exactly what the database would do:
 * prune rows whose expiresAt has passed, then let the unique index serialize.
 */
function prismaLedgerMock(): PrismaClient {
  const rows: { sourceDomain: string; jtiHash: string; expiresAt: Date }[] = [];
  return {
    confidentialAssertionUse: {
      deleteMany: vi.fn(
        async (args: {
          where: { sourceDomain: string; jtiHash: string; expiresAt: { lte: Date } };
        }) => {
          let count = 0;
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            const row = rows[index];
            if (
              row.sourceDomain === args.where.sourceDomain &&
              row.jtiHash === args.where.jtiHash &&
              row.expiresAt.getTime() <= args.where.expiresAt.lte.getTime()
            ) {
              rows.splice(index, 1);
              count += 1;
            }
          }
          return { count };
        },
      ),
      create: vi.fn(
        async (args: { data: { sourceDomain: string; jtiHash: string; expiresAt: Date } }) => {
          const duplicate = rows.some(
            (row) =>
              row.sourceDomain === args.data.sourceDomain && row.jtiHash === args.data.jtiHash,
          );
          if (duplicate) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
          rows.push({ ...args.data });
          return { id: `use-${rows.length}` };
        },
      ),
    },
  } as unknown as PrismaClient;
}

describe('confidential assertion one-time use', () => {
  it('stores only a source-bound jti hash through expiry plus clock tolerance', async () => {
    const prisma = prismaMock();
    const now = new Date('2026-07-19T12:00:00.000Z');
    const expiresAtEpochSeconds = Math.floor(now.getTime() / 1000) + 60;

    await consumeConfidentialAssertion(
      {
        expiresAtEpochSeconds,
        jti: 'private-source-jti',
        sourceDomain: 'api.nessie.works',
      },
      { prisma, now: () => now },
    );

    expect(prisma.confidentialAssertionUse.deleteMany).toHaveBeenCalledWith({
      where: {
        sourceDomain: 'api.nessie.works',
        jtiHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        expiresAt: { lte: now },
      },
    });
    expect(prisma.confidentialAssertionUse.create).toHaveBeenCalledWith({
      data: {
        sourceDomain: 'api.nessie.works',
        jtiHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        expiresAt: new Date(
          (expiresAtEpochSeconds +
            CONFIDENTIAL_ASSERTION_CLOCK_TOLERANCE_SECONDS +
            CONFIDENTIAL_ASSERTION_LEDGER_RETENTION_MARGIN_SECONDS) *
            1000,
        ),
      },
      select: { id: true },
    });
    expect(
      JSON.stringify(vi.mocked(prisma.confidentialAssertionUse.create).mock.calls),
    ).not.toContain('private-source-jti');
  });

  it('maps a unique-constraint collision to an opaque invalid-subject rejection', async () => {
    await expect(
      consumeConfidentialAssertion(
        {
          expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 60,
          jti: 'replayed-jti',
          sourceDomain: 'api.nessie.works',
        },
        { prisma: prismaMock({ duplicate: true }) },
      ),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'INVALID_SUBJECT_TOKEN',
    });
  });

  it('rejects an assertion once its expiry plus tolerance has elapsed', async () => {
    const now = new Date('2026-07-19T12:00:06.000Z');

    await expect(
      consumeConfidentialAssertion(
        {
          expiresAtEpochSeconds: Math.floor(new Date('2026-07-19T12:00:00.000Z').getTime() / 1000),
          jti: 'expired-jti',
          sourceDomain: 'api.nessie.works',
        },
        { prisma: prismaMock(), now: () => now },
      ),
    ).rejects.toThrow('INVALID_SUBJECT_TOKEN');
  });
});

describe('replay at the accepted-expiry boundary', () => {
  const exp = Math.floor(new Date('2026-07-19T12:00:10.000Z').getTime() / 1000);
  const params = {
    expiresAtEpochSeconds: exp,
    jti: 'boundary-replay-jti',
    sourceDomain: 'api.nessie.works',
  };

  // The verifier still accepts the assertion until now reaches exp plus the
  // clock tolerance, so the ledger row must survive that whole window.
  const replayableInstants = [
    ['just before the tolerance boundary', new Date((exp + CONFIDENTIAL_ASSERTION_CLOCK_TOLERANCE_SECONDS) * 1000 - 1)],
    ['exactly at the tolerance boundary', new Date((exp + CONFIDENTIAL_ASSERTION_CLOCK_TOLERANCE_SECONDS) * 1000)],
  ] as const;

  // The consume-time expiry guard alone would still reject these replays;
  // this is the assertion that regresses if the ledger stops outliving exp
  // plus clock tolerance.
  it('retains the ledger row past the last instant the verifier accepts the assertion', async () => {
    const prisma = prismaMock();

    await consumeConfidentialAssertion(params, {
      prisma,
      now: () => new Date('2026-07-19T12:00:00.000Z'),
    });

    const storedExpiresAt = vi.mocked(prisma.confidentialAssertionUse.create).mock.calls[0][0]
      .data.expiresAt;
    expect(storedExpiresAt.getTime()).toBeGreaterThan(
      (exp + CONFIDENTIAL_ASSERTION_CLOCK_TOLERANCE_SECONDS) * 1000,
    );
  });

  it.each(replayableInstants)('rejects a replay %s', async (_label, replayNow) => {
    const prisma = prismaLedgerMock();

    await consumeConfidentialAssertion(params, {
      prisma,
      now: () => new Date('2026-07-19T12:00:00.000Z'),
    });

    await expect(
      consumeConfidentialAssertion(params, { prisma, now: () => replayNow }),
    ).rejects.toThrow('INVALID_SUBJECT_TOKEN');
  });
});
