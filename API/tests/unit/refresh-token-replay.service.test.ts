import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  exchangeRefreshToken,
  issueRefreshToken,
  REFRESH_TOKEN_REPLAY_GRACE_MS,
} from '../../src/services/refresh-token.service.js';
import { hashRefreshToken } from '../../src/services/refresh-token-replay.service.js';
import { AppError } from '../../src/utils/errors.js';

const sharedSecret = 'test-shared-secret-with-enough-length';
const context = {
  clientId: 'client-id',
  configUrl: 'https://client.example.com/auth-config',
  domain: 'client.example.com',
};

type Row = {
  id: string;
  tokenHash: string;
  familyId: string;
  parentTokenId: string | null;
  replacedByTokenId: string | null;
  userId: string;
  domain: string;
  clientId: string;
  configUrl: string;
  orgId: string | null;
  teamId: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

class FakeRefreshStore {
  readonly rows = new Map<string, Row>();
  readonly userUpdate = vi.fn(async () => ({ id: 'user-1' }));
  private nextId = 1;

  readonly client = {
    refreshToken: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `refresh-${this.nextId++}`;
        this.rows.set(id, {
          id,
          tokenHash: data.tokenHash as string,
          familyId: data.familyId as string,
          parentTokenId: (data.parentTokenId as string | undefined) ?? null,
          replacedByTokenId: null,
          userId: data.userId as string,
          domain: data.domain as string,
          clientId: data.clientId as string,
          configUrl: data.configUrl as string,
          orgId: (data.orgId as string | null) ?? null,
          teamId: (data.teamId as string | null) ?? null,
          createdAt: data.createdAt as Date,
          expiresAt: data.expiresAt as Date,
          revokedAt: null,
          lastUsedAt: null,
        });
        return { id };
      }),
      findUnique: vi.fn(async ({ where }: { where: { id?: string; tokenHash?: string } }) => {
        if (where.id) return this.rows.get(where.id) ?? null;
        return [...this.rows.values()].find((row) => row.tokenHash === where.tokenHash) ?? null;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id?: string; familyId?: string; revokedAt?: null };
          data: Partial<Row>;
        }) => {
          let count = 0;
          for (const row of this.rows.values()) {
            const matchesId = where.id === undefined || row.id === where.id;
            const matchesFamily = where.familyId === undefined || row.familyId === where.familyId;
            const matchesLive = where.revokedAt !== null || row.revokedAt === null;
            const matchesUnreplaced =
              !('replacedByTokenId' in where) || row.replacedByTokenId === null;
            if (!matchesId || !matchesFamily || !matchesLive || !matchesUnreplaced) continue;
            Object.assign(row, data);
            count += 1;
          }
          return { count };
        },
      ),
    },
    user: { update: this.userUpdate },
  } as unknown as PrismaClient;

  byRawToken(rawToken: string): Row {
    const hash = hashRefreshToken(rawToken, sharedSecret);
    const row = [...this.rows.values()].find((candidate) => candidate.tokenHash === hash);
    if (!row) throw new Error('missing token row');
    return row;
  }
}

async function fixture(now: Date) {
  const store = new FakeRefreshStore();
  const initial = await issueRefreshToken(
    { ...context, userId: 'user-1', orgId: 'org-1', teamId: 'team-1' },
    {
      now: () => now,
      prisma: store.client,
      refreshTokenTtlSeconds: 3_600,
      sharedSecret,
    },
  );
  return { initial, store };
}

function exchange(
  store: FakeRefreshStore,
  refreshToken: string,
  now: Date,
  beforeRotate?: () => Promise<void>,
) {
  return exchangeRefreshToken(
    { ...context, refreshToken },
    {
      beforeRotate: beforeRotate ? async () => beforeRotate() : undefined,
      now: () => now,
      prisma: store.client,
      refreshTokenTtlSeconds: 3_600,
      sharedSecret,
    },
  );
}

describe('refresh response-loss replay recovery', () => {
  it('returns the exact deterministic successor and its remaining lifetime', async () => {
    const issuedAt = new Date('2026-07-22T10:00:00.000Z');
    const { initial, store } = await fixture(issuedAt);
    const rotatedAt = new Date(issuedAt.getTime() + 1_000);
    const rotated = await exchange(store, initial.refreshToken, rotatedAt);

    const replay = await exchange(
      store,
      initial.refreshToken,
      new Date(rotatedAt.getTime() + 10_500),
    );

    expect(replay).toMatchObject({
      refreshToken: rotated.refreshToken,
      replayed: true,
      expiresInSeconds: 3_589,
      userId: 'user-1',
      orgId: 'org-1',
      teamId: 'team-1',
    });
    expect(store.rows).toHaveLength(2);
    expect(store.userUpdate).not.toHaveBeenCalled();
    expect([...store.rows.values()].every((row) => !('rawToken' in row))).toBe(true);
  });

  it('follows a verified multi-hop chain to the current live descendant', async () => {
    const issuedAt = new Date('2026-07-22T10:00:00.000Z');
    const { initial, store } = await fixture(issuedAt);
    const first = await exchange(store, initial.refreshToken, new Date(issuedAt.getTime() + 1_000));
    const second = await exchange(store, first.refreshToken, new Date(issuedAt.getTime() + 2_000));

    const replay = await exchange(
      store,
      initial.refreshToken,
      new Date(issuedAt.getTime() + 100_000),
    );

    expect(replay).toMatchObject({ refreshToken: second.refreshToken, replayed: true });
    expect(store.rows).toHaveLength(3);
  });

  it('accepts the exact grace boundary, then treats one millisecond later as theft', async () => {
    const issuedAt = new Date('2026-07-22T10:00:00.000Z');
    const { initial, store } = await fixture(issuedAt);
    const rotatedAt = new Date(issuedAt.getTime() + 1_000);
    const rotated = await exchange(store, initial.refreshToken, rotatedAt);

    await expect(
      exchange(
        store,
        initial.refreshToken,
        new Date(rotatedAt.getTime() + REFRESH_TOKEN_REPLAY_GRACE_MS),
      ),
    ).resolves.toMatchObject({ refreshToken: rotated.refreshToken, replayed: true });
    await expect(
      exchange(
        store,
        initial.refreshToken,
        new Date(rotatedAt.getTime() + REFRESH_TOKEN_REPLAY_GRACE_MS + 1),
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_REFRESH_TOKEN' });
    expect([...store.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
    expect(store.userUpdate).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { tokenVersion: { increment: 1 } },
    });
  });

  it('rejects a corrupt cross-family successor without returning it', async () => {
    const issuedAt = new Date('2026-07-22T10:00:00.000Z');
    const { initial, store } = await fixture(issuedAt);
    const rotated = await exchange(store, initial.refreshToken, issuedAt);
    store.byRawToken(rotated.refreshToken).familyId = 'other-family';

    await expect(
      exchange(store, initial.refreshToken, new Date(issuedAt.getTime() + 1_000)),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(store.byRawToken(initial.refreshToken).revokedAt).not.toBeNull();
  });

  it('rejects a revoked or expired current descendant', async () => {
    const issuedAt = new Date('2026-07-22T10:00:00.000Z');
    const revokedFixture = await fixture(issuedAt);
    const revoked = await exchange(revokedFixture.store, revokedFixture.initial.refreshToken, issuedAt);
    revokedFixture.store.byRawToken(revoked.refreshToken).revokedAt = issuedAt;
    await expect(
      exchange(
        revokedFixture.store,
        revokedFixture.initial.refreshToken,
        new Date(issuedAt.getTime() + 1_000),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });

    const expiredFixture = await fixture(issuedAt);
    const expired = await exchange(expiredFixture.store, expiredFixture.initial.refreshToken, issuedAt);
    expiredFixture.store.byRawToken(expired.refreshToken).expiresAt = new Date(
      issuedAt.getTime() + 500,
    );
    await expect(
      exchange(
        expiredFixture.store,
        expiredFixture.initial.refreshToken,
        new Date(issuedAt.getTime() + 1_000),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('re-runs current policy before returning a replayed successor', async () => {
    const issuedAt = new Date('2026-07-22T10:00:00.000Z');
    const { initial, store } = await fixture(issuedAt);
    await exchange(store, initial.refreshToken, issuedAt);
    const policyFailure = new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');

    await expect(
      exchange(store, initial.refreshToken, issuedAt, async () => {
        throw policyFailure;
      }),
    ).rejects.toBe(policyFailure);
    expect(store.userUpdate).not.toHaveBeenCalled();
  });

  it('rejects a different exact client context without revoking the family', async () => {
    const issuedAt = new Date('2026-07-22T10:00:00.000Z');
    const { initial, store } = await fixture(issuedAt);
    await exchange(store, initial.refreshToken, issuedAt);

    await expect(
      exchangeRefreshToken(
        { ...context, domain: 'other.example.com', refreshToken: initial.refreshToken },
        { now: () => issuedAt, prisma: store.client, sharedSecret },
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(store.userUpdate).not.toHaveBeenCalled();
    expect([...store.rows.values()].some((row) => row.revokedAt === null)).toBe(true);
  });
});
