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

describe('confidential assertion one-time use', () => {
  it('stores only a source-bound jti hash through expiry plus clock tolerance plus the retention margin', async () => {
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

  // There used to be `it.each` replays "just before" and "exactly at" the
  // tolerance boundary. They were removed as vacuous: both passed even with
  // the retention margin reverted. At just-before, the old row (expiresAt =
  // exp + tolerance) is not yet prunable so the unique insert collides
  // anyway; at exactly-at, the consume-time expiry guard rejects before the
  // ledger is consulted. The honest pruning-window scenario — replaying an
  // assertion whose row HAS been pruned while the verifier would still accept
  // it — is unreachable: the verifier's acceptance window ends at exp +
  // tolerance, and the consume-time guard rejects anything whose expiresAt
  // has passed, which any pruned row's has by definition. What actually pins
  // the retention margin is the strict-greater assertion above.
});
