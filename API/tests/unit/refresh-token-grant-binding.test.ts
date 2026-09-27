import { describe, expect, it } from 'vitest';

import { issueRefreshToken } from '../../src/services/refresh-token.service.js';
import {
  exchangeTestRefreshToken as exchange,
  FakeRefreshStore,
  TEST_REFRESH_CONTEXT as context,
  TEST_REFRESH_SHARED_SECRET as sharedSecret,
} from '../helpers/fake-refresh-token-store.js';

const binding = {
  credentialEpoch: 3,
  oauthScope: 'openid profile settings.read',
  resource: 'https://api.example.com',
};

async function boundFixture(now: Date) {
  const store = new FakeRefreshStore();
  const initial = await issueRefreshToken(
    { ...context, userId: 'user-1', twoFaCompleted: false, ...binding },
    { now: () => now, prisma: store.client, refreshTokenTtlSeconds: 3_600, sharedSecret },
  );
  return { initial, store };
}

describe('public refresh grant binding', () => {
  it('persists the binding on issue and copies it unchanged through rotation and replay', async () => {
    const issuedAt = new Date('2026-09-27T10:00:00.000Z');
    const { initial, store } = await boundFixture(issuedAt);
    expect(store.byRawToken(initial.refreshToken)).toMatchObject(binding);

    const rotatedAt = new Date(issuedAt.getTime() + 1_000);
    const rotated = await exchange(store, initial.refreshToken, rotatedAt);
    expect(rotated).toMatchObject({ replayed: false, ...binding });
    expect(store.byRawToken(rotated.refreshToken)).toMatchObject(binding);

    const replay = await exchange(
      store,
      initial.refreshToken,
      new Date(rotatedAt.getTime() + 5_000),
    );
    expect(replay).toMatchObject({
      replayed: true,
      refreshToken: rotated.refreshToken,
      ...binding,
    });
  });

  it('returns a null binding for confidential families', async () => {
    const issuedAt = new Date('2026-09-27T10:00:00.000Z');
    const store = new FakeRefreshStore();
    const initial = await issueRefreshToken(
      { ...context, userId: 'user-1', twoFaCompleted: false },
      { now: () => issuedAt, prisma: store.client, refreshTokenTtlSeconds: 3_600, sharedSecret },
    );
    const rotated = await exchange(
      store,
      initial.refreshToken,
      new Date(issuedAt.getTime() + 1_000),
    );
    expect(rotated).toMatchObject({ credentialEpoch: null, oauthScope: null, resource: null });
  });

  it('treats a successor whose binding differs from its family as corruption', async () => {
    const issuedAt = new Date('2026-09-27T10:00:00.000Z');
    const { initial, store } = await boundFixture(issuedAt);
    const rotatedAt = new Date(issuedAt.getTime() + 1_000);
    const rotated = await exchange(store, initial.refreshToken, rotatedAt);
    // A successor row that claims a wider scope than its predecessor must never be returned.
    store.byRawToken(rotated.refreshToken).oauthScope = `${binding.oauthScope} settings.write`;

    await expect(
      exchange(store, initial.refreshToken, new Date(rotatedAt.getTime() + 5_000)),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_REFRESH_TOKEN' });
    expect([...store.rows.values()].every((row) => row.securityRevokedAt !== null)).toBe(true);
    expect(store.userUpdate).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { tokenVersion: { increment: 1 } },
    });
  });
});
