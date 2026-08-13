import { describe, expect, it } from 'vitest';

import {
  exchangeRefreshToken,
  REFRESH_TOKEN_REPLAY_GRACE_MS,
} from '../../src/services/refresh-token.service.js';
import { AppError } from '../../src/utils/errors.js';
import {
  createRefreshFixture as fixture,
  exchangeTestRefreshToken as exchange,
  switchTestWorkspace as switchWorkspace,
  TEST_REFRESH_CONTEXT as context,
  TEST_REFRESH_SHARED_SECRET as sharedSecret,
} from '../helpers/fake-refresh-token-store.js';

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
      expiresInSeconds: 3_590,
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
    const revoked = await exchange(
      revokedFixture.store,
      revokedFixture.initial.refreshToken,
      issuedAt,
    );
    revokedFixture.store.byRawToken(revoked.refreshToken).revokedAt = issuedAt;
    await expect(
      exchange(
        revokedFixture.store,
        revokedFixture.initial.refreshToken,
        new Date(issuedAt.getTime() + 1_000),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });

    const expiredFixture = await fixture(issuedAt);
    const expired = await exchange(
      expiredFixture.store,
      expiredFixture.initial.refreshToken,
      issuedAt,
    );
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

  it('reports one positive second for a still-live subsecond successor', async () => {
    const issuedAt = new Date('2026-07-22T10:00:00.000Z');
    const { initial, store } = await fixture(issuedAt);
    const rotated = await exchange(store, initial.refreshToken, issuedAt);
    store.byRawToken(rotated.refreshToken).expiresAt = new Date(issuedAt.getTime() + 500);

    await expect(
      exchange(store, initial.refreshToken, new Date(issuedAt.getTime() + 1)),
    ).resolves.toMatchObject({ expiresInSeconds: 1, replayed: true });
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

describe('refresh workspace-transition replay', () => {
  const issuedAt = new Date('2026-07-22T11:00:00.000Z');
  const workspaceB = { orgId: 'org-2', teamId: 'team-2' };
  const workspaceC = { orgId: 'org-3', teamId: 'team-3' };

  it('rejects a same-scope switch without consuming the live source', async () => {
    const { initial, store } = await fixture(issuedAt);

    await expect(
      switchWorkspace(store, initial.refreshToken, issuedAt, {
        orgId: 'org-1',
        teamId: 'team-1',
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: 'WORKSPACE_SWITCH_CONFLICT' });
    expect(store.rows).toHaveLength(1);
    expect(store.byRawToken(initial.refreshToken).revokedAt).toBeNull();
    expect(store.userUpdate).not.toHaveBeenCalled();
  });

  it('does not let same-scope intent hide a corrupt replay chain', async () => {
    const { initial, store } = await fixture(issuedAt);
    const rotated = await exchange(store, initial.refreshToken, issuedAt);
    store.byRawToken(rotated.refreshToken).familyId = 'corrupt-family';

    await expect(
      switchWorkspace(store, initial.refreshToken, new Date(issuedAt.getTime() + 1_000), {
        orgId: 'org-1',
        teamId: 'team-1',
      }),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_REFRESH_TOKEN' });
    expect([...store.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
    expect(store.userUpdate).toHaveBeenCalledTimes(1);
  });

  it('revokes a replay predecessor with a partial stored workspace scope', async () => {
    const { initial, store } = await fixture(issuedAt);
    await exchange(store, initial.refreshToken, issuedAt);
    store.byRawToken(initial.refreshToken).teamId = null;

    await expect(
      switchWorkspace(
        store,
        initial.refreshToken,
        new Date(issuedAt.getTime() + 1_000),
        workspaceB,
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_REFRESH_TOKEN' });
    expect([...store.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('creates one deterministic target-scoped successor and replays it for the same intent', async () => {
    const { initial, store } = await fixture(issuedAt);
    const switched = await switchWorkspace(store, initial.refreshToken, issuedAt, workspaceB);
    const replay = await switchWorkspace(
      store,
      initial.refreshToken,
      new Date(issuedAt.getTime() + 1_000),
      workspaceB,
    );

    expect(switched).toMatchObject({ ...workspaceB, twoFaCompleted: true, replayed: false });
    expect(replay).toMatchObject({
      ...workspaceB,
      refreshToken: switched.refreshToken,
      twoFaCompleted: true,
      replayed: true,
    });
    expect(store.rows).toHaveLength(2);
    expect(store.byRawToken(switched.refreshToken)).toMatchObject({
      ...workspaceB,
      twoFaCompleted: true,
    });
  });

  it('retires a committed switch family when replay target policy is no longer satisfied', async () => {
    const { initial, store } = await fixture(issuedAt);
    const switched = await switchWorkspace(store, initial.refreshToken, issuedAt, workspaceB);
    const targetFailure = new AppError('FORBIDDEN', 403, 'INTERACTION_REQUIRED');

    await expect(
      switchWorkspace(
        store,
        initial.refreshToken,
        new Date(issuedAt.getTime() + 1_000),
        workspaceB,
        async () => {
          throw targetFailure;
        },
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_REFRESH_TOKEN' });
    expect(store.byRawToken(switched.refreshToken).revokedAt).not.toBeNull();
    expect(store.userUpdate).not.toHaveBeenCalled();
  });

  it('returns a non-revoking conflict when another grant won the first edge', async () => {
    const switchedFirst = await fixture(issuedAt);
    const switched = await switchWorkspace(
      switchedFirst.store,
      switchedFirst.initial.refreshToken,
      issuedAt,
      workspaceB,
    );
    await expect(
      exchange(
        switchedFirst.store,
        switchedFirst.initial.refreshToken,
        new Date(issuedAt.getTime() + 1_000),
      ),
    ).rejects.toMatchObject({ statusCode: 409, message: 'WORKSPACE_SWITCH_CONFLICT' });
    await expect(
      switchWorkspace(
        switchedFirst.store,
        switchedFirst.initial.refreshToken,
        new Date(issuedAt.getTime() + 1_000),
        workspaceC,
      ),
    ).rejects.toMatchObject({ statusCode: 409, message: 'WORKSPACE_SWITCH_CONFLICT' });
    expect(switchedFirst.store.byRawToken(switched.refreshToken).revokedAt).toBeNull();
    expect(switchedFirst.store.userUpdate).not.toHaveBeenCalled();

    const refreshedFirst = await fixture(issuedAt);
    const refreshed = await exchange(
      refreshedFirst.store,
      refreshedFirst.initial.refreshToken,
      issuedAt,
    );
    await expect(
      switchWorkspace(
        refreshedFirst.store,
        refreshedFirst.initial.refreshToken,
        new Date(issuedAt.getTime() + 1_000),
        workspaceB,
      ),
    ).rejects.toMatchObject({ statusCode: 409, message: 'WORKSPACE_SWITCH_CONFLICT' });
    expect(refreshedFirst.store.byRawToken(refreshed.refreshToken).revokedAt).toBeNull();
    expect(refreshedFirst.store.userUpdate).not.toHaveBeenCalled();
  });

  it('conflicts rather than returning a later descendant from a different switch', async () => {
    const { initial, store } = await fixture(issuedAt);
    const switchedB = await switchWorkspace(store, initial.refreshToken, issuedAt, workspaceB);
    const switchedC = await switchWorkspace(
      store,
      switchedB.refreshToken,
      new Date(issuedAt.getTime() + 1_000),
      workspaceC,
    );

    await expect(
      switchWorkspace(
        store,
        initial.refreshToken,
        new Date(issuedAt.getTime() + 2_000),
        workspaceB,
      ),
    ).rejects.toMatchObject({ statusCode: 409, message: 'WORKSPACE_SWITCH_CONFLICT' });
    expect(store.byRawToken(switchedC.refreshToken).revokedAt).toBeNull();
    expect(store.userUpdate).not.toHaveBeenCalled();
  });

  it('classifies every post-grace predecessor use as theft before intent conflicts', async () => {
    const { initial, store } = await fixture(issuedAt);
    await switchWorkspace(store, initial.refreshToken, issuedAt, workspaceB);

    await expect(
      switchWorkspace(
        store,
        initial.refreshToken,
        new Date(issuedAt.getTime() + REFRESH_TOKEN_REPLAY_GRACE_MS + 1),
        workspaceC,
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_REFRESH_TOKEN' });
    expect([...store.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
    expect(store.userUpdate).toHaveBeenCalledTimes(1);
  });

  it('classifies a same-target switch retry after grace as theft', async () => {
    const { initial, store } = await fixture(issuedAt);
    await switchWorkspace(store, initial.refreshToken, issuedAt, workspaceB);

    await expect(
      switchWorkspace(
        store,
        initial.refreshToken,
        new Date(issuedAt.getTime() + REFRESH_TOKEN_REPLAY_GRACE_MS + 1),
        workspaceB,
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_REFRESH_TOKEN' });
    expect([...store.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
    expect(store.userUpdate).toHaveBeenCalledTimes(1);
  });

  it('detects a detached corrupt successor before post-grace family revocation', async () => {
    const { initial, store } = await fixture(issuedAt);
    const switched = await switchWorkspace(store, initial.refreshToken, issuedAt, workspaceB);
    store.byRawToken(switched.refreshToken).familyId = 'detached-family';

    await expect(
      switchWorkspace(
        store,
        initial.refreshToken,
        new Date(issuedAt.getTime() + REFRESH_TOKEN_REPLAY_GRACE_MS + 1),
        workspaceB,
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_REFRESH_TOKEN' });
    expect([...store.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
    expect(store.userUpdate).toHaveBeenCalledTimes(1);
  });

  it('bumps the access-token epoch for corruption even when all refresh rows are revoked', async () => {
    const { initial, store } = await fixture(issuedAt);
    const switched = await switchWorkspace(store, initial.refreshToken, issuedAt, workspaceB);
    const successor = store.byRawToken(switched.refreshToken);
    successor.familyId = 'detached-family';
    successor.revokedAt = issuedAt;

    await expect(
      switchWorkspace(
        store,
        initial.refreshToken,
        new Date(issuedAt.getTime() + 1_000),
        workspaceB,
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_REFRESH_TOKEN' });
    expect([...store.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
    expect(store.userUpdate).toHaveBeenCalledTimes(1);
  });

  it('rechecks grace after replay policy before returning the successor', async () => {
    const { initial, store } = await fixture(issuedAt);
    await switchWorkspace(store, initial.refreshToken, issuedAt, workspaceB);
    let now = new Date(issuedAt.getTime() + REFRESH_TOKEN_REPLAY_GRACE_MS);

    await expect(
      exchangeRefreshToken(
        { ...context, refreshToken: initial.refreshToken, workspace: workspaceB },
        {
          beforeReplay: async () => {
            now = new Date(now.getTime() + 1);
          },
          now: () => now,
          prisma: store.client,
          refreshTokenTtlSeconds: 3_600,
          sharedSecret,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_REFRESH_TOKEN' });
    expect([...store.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
    expect(store.userUpdate).toHaveBeenCalledTimes(1);
  });

  it('uses theft revocation when failed replay policy finishes after grace', async () => {
    const { initial, store } = await fixture(issuedAt);
    await switchWorkspace(store, initial.refreshToken, issuedAt, workspaceB);
    let now = new Date(issuedAt.getTime() + REFRESH_TOKEN_REPLAY_GRACE_MS);

    await expect(
      exchangeRefreshToken(
        { ...context, refreshToken: initial.refreshToken, workspace: workspaceB },
        {
          beforeReplay: async () => {
            now = new Date(now.getTime() + 1);
            throw new AppError('FORBIDDEN', 403, 'INTERACTION_REQUIRED');
          },
          now: () => now,
          prisma: store.client,
          refreshTokenTtlSeconds: 3_600,
          sharedSecret,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_REFRESH_TOKEN' });
    expect([...store.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
    expect(store.userUpdate).toHaveBeenCalledTimes(1);
  });

  it('revokes a family whose deterministic successor changes immutable assurance', async () => {
    const { initial, store } = await fixture(issuedAt);
    const switched = await switchWorkspace(store, initial.refreshToken, issuedAt, workspaceB);
    store.byRawToken(switched.refreshToken).twoFaCompleted = false;

    await expect(
      switchWorkspace(
        store,
        initial.refreshToken,
        new Date(issuedAt.getTime() + 1_000),
        workspaceB,
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_REFRESH_TOKEN' });
    expect([...store.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
    expect(store.userUpdate).toHaveBeenCalledTimes(1);
  });
});
