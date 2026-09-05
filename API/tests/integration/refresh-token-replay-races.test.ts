import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { validateConfigFields, type ClientConfig } from '../../src/services/config.service.js';
import {
  issueRefreshToken,
  REFRESH_TOKEN_REPLAY_GRACE_MS,
  revokeRefreshTokenFamily,
} from '../../src/services/refresh-token.service.js';
import { exchangeRefreshTokenForTokens } from '../../src/services/token.service.js';
import { createClientId } from '../../src/utils/hash.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';
import { verifyIssuedAccessToken } from '../helpers/access-token.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const domain = 'refresh-replay-race.example';
const sharedSecret = 'test-shared-secret-with-enough-length';

type IssuedRefresh = Awaited<ReturnType<typeof issueRefreshToken>> & {
  clientId: string;
  configUrl: string;
  domain: string;
  userId: string;
};

function config(configDomain = domain): ClientConfig {
  return validateConfigFields(
    baseClientConfigPayload({
      domain: configDomain,
      redirect_urls: [`https://${configDomain}/oauth/callback`],
      login_flow: { email_code_enabled: false, team_selection: 'off' },
      org_features: { enabled: false, user_needs_team: false },
    }),
  );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function expectStillPending(promise: Promise<unknown>): Promise<void> {
  const state = await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
  ]);
  expect(state).toBe('pending');
}

describe.skipIf(!hasDatabase)('refresh response-loss PostgreSQL serialization', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
    ACCESS_TOKEN_TTL: process.env.ACCESS_TOKEN_TTL,
  };

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.databaseUrl;
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.ACCESS_TOKEN_TTL = '15m';
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    await handle.prisma.refreshToken.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  async function seedUser(): Promise<string> {
    return (
      await handle.prisma.user.create({
        data: {
          email: `refresh-${randomUUID()}@example.com`,
          userKey: randomUUID(),
        },
        select: { id: true },
      })
    ).id;
  }

  async function issueForUser(userId: string, issuingDomain = domain): Promise<IssuedRefresh> {
    await handle.prisma.domainRole.create({
      data: { domain: issuingDomain, userId, role: 'USER' },
    });
    const clientId = createClientId(issuingDomain, sharedSecret);
    const configUrl = `https://${issuingDomain}/auth-config/${randomUUID()}`;
    const token = await issueRefreshToken(
      { userId, domain: issuingDomain, clientId, configUrl, twoFaCompleted: false },
      { prisma: handle.prisma, refreshTokenTtlSeconds: 3_600, sharedSecret },
    );
    return { ...token, clientId, configUrl, domain: issuingDomain, userId };
  }

  async function issue(): Promise<IssuedRefresh> {
    return issueForUser(await seedUser());
  }

  function refresh(
    token: IssuedRefresh,
    refreshToken = token.refreshToken,
    afterRefreshSessionLock?: () => Promise<void>,
  ) {
    return exchangeRefreshTokenForTokens(
      {
        clientId: token.clientId,
        config: config(token.domain),
        configUrl: token.configUrl,
        refreshToken,
      },
      {
        adminPrisma: handle.prisma,
        prisma: handle.prisma,
        sharedSecret,
        afterRefreshSessionLock,
      },
    );
  }

  function revoke(
    token: IssuedRefresh,
    afterFamilyRevocationLock?: () => Promise<void>,
  ): Promise<void> {
    return revokeRefreshTokenFamily(
      {
        clientId: token.clientId,
        configUrl: token.configUrl,
        domain: token.domain,
        refreshToken: token.refreshToken,
      },
      { prisma: handle.prisma, sharedSecret, afterFamilyRevocationLock },
    );
  }

  async function expectOneLive(expectedRows: number): Promise<void> {
    const rows = await handle.prisma.refreshToken.findMany({
      select: { revokedAt: true },
    });
    expect(rows).toHaveLength(expectedRows);
    expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
  }

  it('recovers the exact successor when the first successful response is lost', async () => {
    const original = await issue();
    const rotated = await refresh(original);

    const replay = await refresh(original);

    expect(replay.refreshToken).toBe(rotated.refreshToken);
    await expectOneLive(2);
  });

  it('makes concurrent predecessor submissions converge on one successor', async () => {
    const original = await issue();
    const locked = deferred();
    const release = deferred();
    const first = refresh(original, original.refreshToken, async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const second = refresh(original);
    await expectStillPending(second);
    release.resolve();

    const [left, right] = await Promise.all([first, second]);
    expect(left.refreshToken).toBe(right.refreshToken);
    await expectOneLive(2);
  });

  it('replays through a concurrent current-token rotation to its newest descendant', async () => {
    const original = await issue();
    const current = await refresh(original);
    const locked = deferred();
    const release = deferred();
    const advance = refresh(original, current.refreshToken, async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const replay = refresh(original);
    await expectStillPending(replay);
    release.resolve();

    const [advanced, recovered] = await Promise.all([advance, replay]);
    expect(recovered.refreshToken).toBe(advanced.refreshToken);
    await expectOneLive(3);
  });

  it('commits family and access-token epoch revocation after the grace window', async () => {
    const original = await issue();
    await refresh(original);
    const predecessor = await handle.prisma.refreshToken.findFirstOrThrow({
      where: { replacedByTokenId: { not: null } },
      select: { id: true, userId: true },
    });
    await handle.prisma.refreshToken.update({
      where: { id: predecessor.id },
      data: { revokedAt: new Date(Date.now() - REFRESH_TOKEN_REPLAY_GRACE_MS - 1) },
    });

    await expect(refresh(original)).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_REFRESH_TOKEN',
    });
    const rows = await handle.prisma.refreshToken.findMany({ select: { revokedAt: true } });
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    expect(
      await handle.prisma.user.findUniqueOrThrow({
        where: { id: predecessor.userId },
        select: { tokenVersion: true },
      }),
    ).toEqual({ tokenVersion: 1 });
  });

  it('bumps the epoch once when theft follows an earlier policy retirement', async () => {
    const original = await issue();
    await refresh(original);
    const predecessor = await handle.prisma.refreshToken.findUniqueOrThrow({
      where: { id: original.refreshTokenId },
      select: { familyId: true, userId: true },
    });
    await handle.prisma.refreshToken.updateMany({
      where: { familyId: predecessor.familyId },
      data: { revokedAt: new Date() },
    });
    await handle.prisma.refreshToken.update({
      where: { id: original.refreshTokenId },
      data: { revokedAt: new Date(Date.now() - REFRESH_TOKEN_REPLAY_GRACE_MS - 1) },
    });

    await expect(refresh(original)).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_REFRESH_TOKEN',
    });
    await expect(refresh(original)).rejects.toMatchObject({ statusCode: 401 });
    expect(
      await handle.prisma.refreshToken.count({
        where: { familyId: predecessor.familyId, securityRevokedAt: null },
      }),
    ).toBe(0);
    expect(
      await handle.prisma.user.findUniqueOrThrow({
        where: { id: predecessor.userId },
        select: { tokenVersion: true },
      }),
    ).toEqual({ tokenVersion: 1 });
  });

  it('revokes all user refresh state when a post-grace successor is detached', async () => {
    const original = await issue();
    const rotated = await refresh(original);
    const sibling = await issueForUser(original.userId, 'refresh-corrupt-sibling.example');
    const predecessor = await handle.prisma.refreshToken.findUniqueOrThrow({
      where: { id: original.refreshTokenId },
      select: { replacedByTokenId: true },
    });
    await handle.prisma.refreshToken.update({
      where: { id: predecessor.replacedByTokenId! },
      data: { familyId: randomUUID() },
    });
    await handle.prisma.refreshToken.update({
      where: { id: original.refreshTokenId },
      data: { revokedAt: new Date(Date.now() - REFRESH_TOKEN_REPLAY_GRACE_MS - 1) },
    });

    await expect(refresh(original)).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_REFRESH_TOKEN',
    });
    expect(
      await handle.prisma.refreshToken.findMany({
        where: { userId: original.userId },
        select: { revokedAt: true },
      }),
    ).toEqual(expect.arrayContaining([{ revokedAt: expect.any(Date) }]));
    expect(
      await handle.prisma.refreshToken.count({
        where: { userId: original.userId, revokedAt: null },
      }),
    ).toBe(0);
    await expect(refresh(original, rotated.refreshToken)).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(refresh(sibling)).rejects.toMatchObject({ statusCode: 401 });
    expect(
      await handle.prisma.user.findUniqueOrThrow({
        where: { id: original.userId },
        select: { tokenVersion: true },
      }),
    ).toEqual({ tokenVersion: 1 });
  });

  it('does not let the same corrupt capability revoke a subsequently issued family', async () => {
    const original = await issue();
    await refresh(original);
    const predecessor = await handle.prisma.refreshToken.findUniqueOrThrow({
      where: { id: original.refreshTokenId },
      select: { replacedByTokenId: true },
    });
    await handle.prisma.refreshToken.update({
      where: { id: predecessor.replacedByTokenId! },
      data: { familyId: randomUUID() },
    });

    await expect(refresh(original)).rejects.toMatchObject({ statusCode: 401 });
    const replacement = await issueForUser(original.userId, 'refresh-after-corruption.example');
    await expect(refresh(original)).rejects.toMatchObject({ statusCode: 401 });

    expect(
      await handle.prisma.refreshToken.findUniqueOrThrow({
        where: { id: replacement.refreshTokenId },
        select: { revokedAt: true, securityRevokedAt: true },
      }),
    ).toEqual({ revokedAt: null, securityRevokedAt: null });
    expect(
      await handle.prisma.user.findUniqueOrThrow({
        where: { id: original.userId },
        select: { tokenVersion: true },
      }),
    ).toEqual({ tokenVersion: 1 });
  });

  it('retires only a valid family whose rotation chain exceeds the traversal bound', async () => {
    const original = await issue();
    const sibling = await issueForUser(original.userId, 'refresh-deep-chain-sibling.example');
    const originalFamily = await handle.prisma.refreshToken.findUniqueOrThrow({
      where: { id: original.refreshTokenId },
      select: { familyId: true },
    });
    let current = original.refreshToken;
    for (let rotation = 0; rotation < 33; rotation += 1) {
      current = (await refresh(original, current)).refreshToken;
    }

    await expect(refresh(original)).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_REFRESH_TOKEN',
    });
    expect(
      await handle.prisma.refreshToken.count({
        where: { familyId: originalFamily.familyId, revokedAt: null },
      }),
    ).toBe(0);
    expect(
      await handle.prisma.refreshToken.findUniqueOrThrow({
        where: { id: sibling.refreshTokenId },
        select: { revokedAt: true },
      }),
    ).toEqual({ revokedAt: null });
    await expect(refresh(sibling)).resolves.toMatchObject({ refreshToken: expect.any(String) });
  });

  it('makes sequential logout retries idempotent and lets a sibling domain heal', async () => {
    const userId = await seedUser();
    const original = await issueForUser(userId);
    const sibling = await issueForUser(userId, 'refresh-replay-sibling.example');

    await revoke(original);
    await revoke(original);

    expect(
      await handle.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { tokenVersion: true },
      }),
    ).toEqual({ tokenVersion: 1 });
    const healed = await refresh(sibling);
    const payload = await verifyIssuedAccessToken(healed.accessToken, {
      issuer: 'uoa-auth-service',
      sharedSecret,
    });
    expect(payload.tv).toBe(1);
  });

  it('makes concurrent logout retries bump the user epoch exactly once', async () => {
    const original = await issue();
    const locked = deferred();
    const release = deferred();
    const first = revoke(original, async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const second = revoke(original);
    await expectStillPending(second);
    release.resolve();
    await Promise.all([first, second]);

    expect(
      await handle.prisma.user.findUniqueOrThrow({
        where: { id: original.userId },
        select: { tokenVersion: true },
      }),
    ).toEqual({ tokenVersion: 1 });
  });
});
