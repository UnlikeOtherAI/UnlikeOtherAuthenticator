import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resetPasswordWithToken } from '../../src/services/auth-reset-password.service.js';
import { validateConfigFields, type ClientConfig } from '../../src/services/config.service.js';
import { verifyAccessToken } from '../../src/services/access-token.service.js';
import {
  issueRefreshToken,
  revokeRefreshTokenFamily,
} from '../../src/services/refresh-token.service.js';
import { exchangeRefreshTokenForTokens } from '../../src/services/token.service.js';
import { resetTwoFaWithToken } from '../../src/services/twofactor-reset.service.js';
import { createClientId } from '../../src/utils/hash.js';
import { hashEmailToken } from '../../src/utils/verification-token.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const domain = 'credential-revocation-race.example';
const configUrl = `https://${domain}/auth-config`;
const sharedSecret = 'test-shared-secret-with-enough-length';

type LegacyRefresh = Awaited<ReturnType<typeof issueRefreshToken>> & {
  clientId: string;
  configUrl: string;
  domain: string;
};

function clientConfig(): ClientConfig {
  return validateConfigFields(
    baseClientConfigPayload({
      domain,
      redirect_urls: [`https://${domain}/oauth/callback`],
      login_flow: { email_code_enabled: false, workspace_selection: 'off' },
      org_features: { enabled: false },
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

describe.skipIf(!hasDatabase)('refresh versus logout and credential revocation', () => {
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
    await handle.prisma.verificationToken.deleteMany();
    await handle.prisma.refreshToken.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  async function seedUser(): Promise<{ email: string; id: string }> {
    const email = `credential-${randomUUID()}@example.com`;
    return handle.prisma.user.create({
      data: {
        email,
        userKey: email,
        passwordHash: 'old-password-hash',
        twoFaEnabled: true,
        twoFaSecret: 'encrypted-test-secret',
      },
      select: { email: true, id: true },
    });
  }

  async function issueLegacy(userId: string): Promise<LegacyRefresh> {
    const clientId = createClientId(domain, sharedSecret);
    const token = await issueRefreshToken(
      { userId, domain, clientId, configUrl, orgId: null, teamId: null },
      { prisma: handle.prisma, refreshTokenTtlSeconds: 3600, sharedSecret },
    );
    return { ...token, clientId, configUrl, domain };
  }

  function withRefreshValue(token: LegacyRefresh, refreshToken: string): LegacyRefresh {
    return { ...token, refreshToken };
  }

  function refreshLegacy(
    token: LegacyRefresh,
    afterRefreshSessionLock?: () => Promise<void>,
  ) {
    return exchangeRefreshTokenForTokens(
      {
        clientId: token.clientId,
        config: clientConfig(),
        configUrl: token.configUrl,
        refreshToken: token.refreshToken,
      },
      {
        adminPrisma: handle.prisma,
        prisma: handle.prisma,
        sharedSecret,
        afterRefreshSessionLock,
      },
    );
  }

  async function expectStillPending(promise: Promise<unknown>): Promise<void> {
    const state = await Promise.race([
      promise.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 40)),
    ]);
    expect(state).toBe('pending');
  }

  async function expectAllRevoked(userId: string, expectedCount: number): Promise<void> {
    const rows = await handle.prisma.refreshToken.findMany({
      where: { userId },
      select: { revokedAt: true },
    });
    expect(rows).toHaveLength(expectedCount);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  }

  async function expectPairDead(
    original: LegacyRefresh,
    pair: Awaited<ReturnType<typeof refreshLegacy>>,
  ): Promise<void> {
    await expect(
      refreshLegacy(withRefreshValue(original, pair.refreshToken)),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      verifyAccessToken(pair.accessToken, { prisma: handle.prisma, sharedSecret }),
    ).rejects.toMatchObject({ statusCode: 401 });
  }

  async function createRecoveryToken(
    user: { email: string; id: string },
    type: 'PASSWORD_RESET' | 'TWOFA_RESET',
  ): Promise<string> {
    const rawToken = `${type.toLowerCase()}-${randomUUID()}`;
    await handle.prisma.verificationToken.create({
      data: {
        type,
        email: user.email,
        userKey: user.email,
        domain: null,
        configUrl,
        tokenHash: hashEmailToken(rawToken, sharedSecret),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        userId: user.id,
      },
    });
    return rawToken;
  }

  function resetPassword(
    rawToken: string,
    hooks?: {
      afterRefreshSessionLock?: () => Promise<void>;
      beforeRefreshSessionLock?: () => Promise<void>;
    },
  ) {
    return resetPasswordWithToken(
      { token: rawToken, password: 'new-password', config: clientConfig(), configUrl },
      {
        prisma: handle.prisma,
        sharedSecret,
        hashPassword: async () => 'new-password-hash',
        ...hooks,
      },
    );
  }

  function resetTwoFactor(
    rawToken: string,
    hooks?: {
      afterRefreshSessionLock?: () => Promise<void>;
      beforeRefreshSessionLock?: () => Promise<void>;
    },
  ) {
    return resetTwoFaWithToken(
      { token: rawToken, config: clientConfig(), configUrl },
      { prisma: handle.prisma, sharedSecret, ...hooks },
    );
  }

  it('refresh-first lets logout revoke the replacement and its access token', async () => {
    const user = await seedUser();
    const original = await issueLegacy(user.id);
    const refreshLocked = deferred();
    const releaseRefresh = deferred();
    const rotation = refreshLegacy(original, async () => {
      refreshLocked.resolve();
      await releaseRefresh.promise;
    });
    await refreshLocked.promise;

    const logoutAttempted = deferred();
    const logout = revokeRefreshTokenFamily(original, {
      prisma: handle.prisma,
      sharedSecret,
      beforeFamilyRevocationLock: async () => logoutAttempted.resolve(),
    });
    await logoutAttempted.promise;
    await expectStillPending(logout);
    releaseRefresh.resolve();

    const pair = await rotation;
    await expect(logout).resolves.toBeUndefined();
    await expectAllRevoked(user.id, 2);
    await expectPairDead(original, pair);
  });

  it('logout-first prevents a waiting refresh from creating a replacement', async () => {
    const user = await seedUser();
    const original = await issueLegacy(user.id);
    const logoutLocked = deferred();
    const releaseLogout = deferred();
    const logout = revokeRefreshTokenFamily(original, {
      prisma: handle.prisma,
      sharedSecret,
      afterFamilyRevocationLock: async () => {
        logoutLocked.resolve();
        await releaseLogout.promise;
      },
    });
    await logoutLocked.promise;

    const rotation = refreshLegacy(original);
    await expectStillPending(rotation);
    releaseLogout.resolve();

    await expect(logout).resolves.toBeUndefined();
    await expect(rotation).rejects.toMatchObject({ statusCode: 401 });
    await expectAllRevoked(user.id, 1);
  });

  it('refresh-first is fully invalidated by the waiting password reset', async () => {
    const user = await seedUser();
    const original = await issueLegacy(user.id);
    const rawReset = await createRecoveryToken(user, 'PASSWORD_RESET');
    const refreshLocked = deferred();
    const releaseRefresh = deferred();
    const rotation = refreshLegacy(original, async () => {
      refreshLocked.resolve();
      await releaseRefresh.promise;
    });
    await refreshLocked.promise;

    const resetAttempted = deferred();
    const reset = resetPassword(rawReset, {
      beforeRefreshSessionLock: async () => resetAttempted.resolve(),
    });
    await resetAttempted.promise;
    await expectStillPending(reset);
    releaseRefresh.resolve();

    const pair = await rotation;
    await expect(reset).resolves.toEqual({ userId: user.id });
    await expectAllRevoked(user.id, 2);
    await expectPairDead(original, pair);
  });

  it('password-reset-first prevents a waiting refresh from minting', async () => {
    const user = await seedUser();
    const original = await issueLegacy(user.id);
    const rawReset = await createRecoveryToken(user, 'PASSWORD_RESET');
    const resetLocked = deferred();
    const releaseReset = deferred();
    const reset = resetPassword(rawReset, {
      afterRefreshSessionLock: async () => {
        resetLocked.resolve();
        await releaseReset.promise;
      },
    });
    await resetLocked.promise;

    const rotation = refreshLegacy(original);
    await expectStillPending(rotation);
    releaseReset.resolve();

    await expect(reset).resolves.toEqual({ userId: user.id });
    await expect(rotation).rejects.toMatchObject({ statusCode: 401 });
    await expectAllRevoked(user.id, 1);
  });

  it('refresh-first is fully invalidated by the waiting 2FA reset', async () => {
    const user = await seedUser();
    const original = await issueLegacy(user.id);
    const rawReset = await createRecoveryToken(user, 'TWOFA_RESET');
    const refreshLocked = deferred();
    const releaseRefresh = deferred();
    const rotation = refreshLegacy(original, async () => {
      refreshLocked.resolve();
      await releaseRefresh.promise;
    });
    await refreshLocked.promise;

    const resetAttempted = deferred();
    const reset = resetTwoFactor(rawReset, {
      beforeRefreshSessionLock: async () => resetAttempted.resolve(),
    });
    await resetAttempted.promise;
    await expectStillPending(reset);
    releaseRefresh.resolve();

    const pair = await rotation;
    await expect(reset).resolves.toEqual({ userId: user.id });
    await expectAllRevoked(user.id, 2);
    await expectPairDead(original, pair);
  });

  it('2FA-reset-first prevents a waiting refresh from minting', async () => {
    const user = await seedUser();
    const original = await issueLegacy(user.id);
    const rawReset = await createRecoveryToken(user, 'TWOFA_RESET');
    const resetLocked = deferred();
    const releaseReset = deferred();
    const reset = resetTwoFactor(rawReset, {
      afterRefreshSessionLock: async () => {
        resetLocked.resolve();
        await releaseReset.promise;
      },
    });
    await resetLocked.promise;

    const rotation = refreshLegacy(original);
    await expectStillPending(rotation);
    releaseReset.resolve();

    await expect(reset).resolves.toEqual({ userId: user.id });
    await expect(rotation).rejects.toMatchObject({ statusCode: 401 });
    await expectAllRevoked(user.id, 1);
  });
});
