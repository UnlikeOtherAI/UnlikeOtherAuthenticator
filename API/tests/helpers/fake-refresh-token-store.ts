import type { PrismaClient } from '@prisma/client';
import { vi } from 'vitest';

import {
  exchangeRefreshToken,
  issueRefreshToken,
} from '../../src/services/refresh-token.service.js';
import { hashRefreshToken } from '../../src/services/refresh-token-replay.service.js';

export const TEST_REFRESH_SHARED_SECRET = 'test-shared-secret-with-enough-length';
export const TEST_REFRESH_CONTEXT = {
  clientId: 'client-id',
  configUrl: 'https://client.example.com/auth-config',
  domain: 'client.example.com',
};

export type FakeRefreshTokenRow = {
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
  twoFaCompleted: boolean;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  securityRevokedAt: Date | null;
  lastUsedAt: Date | null;
};

export class FakeRefreshStore {
  readonly rows = new Map<string, FakeRefreshTokenRow>();
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
          twoFaCompleted: data.twoFaCompleted === true,
          createdAt: data.createdAt as Date,
          expiresAt: data.expiresAt as Date,
          revokedAt: null,
          securityRevokedAt: null,
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
          where: {
            id?: string;
            familyId?: string;
            userId?: string;
            revokedAt?: null;
            securityRevokedAt?: null;
          };
          data: Partial<FakeRefreshTokenRow>;
        }) => {
          let count = 0;
          for (const row of this.rows.values()) {
            const matchesId = where.id === undefined || row.id === where.id;
            const matchesFamily = where.familyId === undefined || row.familyId === where.familyId;
            const matchesUser = where.userId === undefined || row.userId === where.userId;
            const matchesLive = where.revokedAt !== null || row.revokedAt === null;
            const matchesSecurity =
              where.securityRevokedAt !== null || row.securityRevokedAt === null;
            const matchesUnreplaced =
              !('replacedByTokenId' in where) || row.replacedByTokenId === null;
            if (
              !matchesId ||
              !matchesFamily ||
              !matchesUser ||
              !matchesLive ||
              !matchesSecurity ||
              !matchesUnreplaced
            )
              continue;
            Object.assign(row, data);
            count += 1;
          }
          return { count };
        },
      ),
    },
    user: { update: this.userUpdate },
  } as unknown as PrismaClient;

  byRawToken(rawToken: string): FakeRefreshTokenRow {
    const hash = hashRefreshToken(rawToken, TEST_REFRESH_SHARED_SECRET);
    const row = [...this.rows.values()].find((candidate) => candidate.tokenHash === hash);
    if (!row) throw new Error('missing token row');
    return row;
  }
}

export async function createRefreshFixture(now: Date) {
  const store = new FakeRefreshStore();
  const initial = await issueRefreshToken(
    {
      ...TEST_REFRESH_CONTEXT,
      userId: 'user-1',
      orgId: 'org-1',
      teamId: 'team-1',
      twoFaCompleted: true,
    },
    {
      now: () => now,
      prisma: store.client,
      refreshTokenTtlSeconds: 3_600,
      sharedSecret: TEST_REFRESH_SHARED_SECRET,
    },
  );
  return { initial, store };
}

export function exchangeTestRefreshToken(
  store: FakeRefreshStore,
  refreshToken: string,
  now: Date,
  beforeRotate?: () => Promise<void>,
) {
  return exchangeRefreshToken(
    { ...TEST_REFRESH_CONTEXT, refreshToken },
    {
      beforeRotate: beforeRotate ? async () => beforeRotate() : undefined,
      now: () => now,
      prisma: store.client,
      refreshTokenTtlSeconds: 3_600,
      sharedSecret: TEST_REFRESH_SHARED_SECRET,
    },
  );
}

export function switchTestTeam(
  store: FakeRefreshStore,
  refreshToken: string,
  now: Date,
  team: { orgId: string; teamId: string },
  beforeReplay?: () => Promise<void>,
) {
  return exchangeRefreshToken(
    { ...TEST_REFRESH_CONTEXT, refreshToken, team },
    {
      beforeReplay: beforeReplay ? async () => beforeReplay() : undefined,
      now: () => now,
      prisma: store.client,
      refreshTokenTtlSeconds: 3_600,
      sharedSecret: TEST_REFRESH_SHARED_SECRET,
    },
  );
}
