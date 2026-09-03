import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { issueAuthorizationCode } from '../../src/services/authorization-code.service.js';
import { validateConfigFields, type ClientConfig } from '../../src/services/config.service.js';
import { revokeAllRefreshTokensForUser } from '../../src/services/refresh-token-revocation.service.js';
import {
  completeSigningContinuation,
  hashSigningContinuationToken,
} from '../../src/services/signature-continuation.service.js';
import { exchangeAuthorizationCodeForTokens } from '../../src/services/token.service.js';
import { createClientId } from '../../src/utils/hash.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const domain = 'authorization-epoch-race.example';
const configUrl = `https://${domain}/auth-config`;
const redirectUrl = `https://${domain}/oauth/callback`;
const sharedSecret = 'authorization-epoch-race-shared-secret';
const verifier = 'authorization-epoch-race-verifier-abcdefghijklmnopqrstuvwxyz';
const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function clientConfig(): ClientConfig {
  return validateConfigFields(
    baseClientConfigPayload({
      domain,
      redirect_urls: [redirectUrl],
      login_flow: { email_code_enabled: false, team_selection: 'off' },
      org_features: { enabled: false },
    }),
  );
}

describe.skipIf(!hasDatabase)('authorization credential-epoch races', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const originalEnv = {
    ACCESS_TOKEN_TTL: process.env.ACCESS_TOKEN_TTL,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
    DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
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
    await handle.prisma.signingContinuation.deleteMany();
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.refreshToken.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();
    await handle.prisma.clientDomain.upsert({
      where: { domain },
      create: { domain, label: 'Authorization epoch race' },
      update: {},
    });
  });

  async function seedUser(): Promise<{ id: string }> {
    const email = `epoch-${randomUUID()}@example.com`;
    return handle.prisma.user.create({
      data: { email, userKey: email },
      select: { id: true },
    });
  }

  async function issueCode(userId: string): Promise<string> {
    return (
      await issueAuthorizationCode(
        {
          userId,
          domain,
          configUrl,
          redirectUrl,
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
          rememberMe: true,
          twoFaCompleted: true,
          credentialEpoch: 0,
        },
        { prisma: handle.prisma, sharedSecret },
      )
    ).code;
  }

  function exchange(code: string, afterLock?: () => Promise<void>) {
    return exchangeAuthorizationCodeForTokens(
      {
        code,
        config: clientConfig(),
        configUrl,
        redirectUrl,
        codeVerifier: verifier,
        clientId: createClientId(domain, sharedSecret),
      },
      {
        adminPrisma: handle.prisma,
        prisma: handle.prisma,
        sharedSecret,
        afterAuthorizationCodeAuthenticationLock: afterLock,
      },
    );
  }

  async function seedContinuation(userId: string): Promise<string> {
    const signingToken = `signing-${randomUUID()}`;
    await handle.prisma.signingContinuation.create({
      data: {
        tokenHash: hashSigningContinuationToken(signingToken, sharedSecret),
        userId,
        domain,
        authProfile: 'CONFIG_JWT',
        configUrl,
        redirectUrl,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        rememberMe: true,
        requestAccess: false,
        authMethod: 'email_password',
        twoFaCompleted: true,
        tokenVersion: 0,
        policyRevision: 0,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    return signingToken;
  }

  function complete(signingToken: string, afterLock?: () => Promise<void>) {
    return completeSigningContinuation(signingToken, {
      prisma: handle.prisma,
      teamPrisma: handle.prisma,
      sharedSecret,
      publicBaseUrl: 'https://auth.example.com',
      afterAuthenticationEpochLock: afterLock,
    });
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

  it('reset-first rejects a waiting code without consuming it', async () => {
    const user = await seedUser();
    const code = await issueCode(user.id);
    const resetLocked = deferred();
    const releaseReset = deferred();
    const reset = revokeAllRefreshTokensForUser(user.id, {
      prisma: handle.prisma,
      afterUserLock: async () => {
        resetLocked.resolve();
        await releaseReset.promise;
      },
    });
    await resetLocked.promise;

    const redemption = exchange(code);
    await expectStillPending(redemption);
    releaseReset.resolve();

    await expect(reset).resolves.toBeUndefined();
    await expect(redemption).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_AUTH_CODE',
    });
    expect(await handle.prisma.authorizationCode.findFirstOrThrow()).toMatchObject({
      usedAt: null,
    });
    expect(await handle.prisma.refreshToken.count()).toBe(0);
  });

  it('redemption-first commits before reset revokes the new family and epoch', async () => {
    const user = await seedUser();
    const code = await issueCode(user.id);
    const redemptionLocked = deferred();
    const releaseRedemption = deferred();
    const redemption = exchange(code, async () => {
      redemptionLocked.resolve();
      await releaseRedemption.promise;
    });
    await redemptionLocked.promise;

    const reset = revokeAllRefreshTokensForUser(user.id, { prisma: handle.prisma });
    await expectStillPending(reset);
    releaseRedemption.resolve();

    await expect(redemption).resolves.toMatchObject({ accessToken: expect.any(String) });
    await expect(reset).resolves.toBeUndefined();
    expect(await handle.prisma.authorizationCode.findFirstOrThrow()).toMatchObject({
      usedAt: expect.any(Date),
    });
    expect(await handle.prisma.refreshToken.findFirstOrThrow()).toMatchObject({
      revokedAt: expect.any(Date),
    });
    expect(await handle.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
      tokenVersion: 1,
    });
  });

  it('reset-first rejects a waiting signing continuation before consumption', async () => {
    const user = await seedUser();
    const signingToken = await seedContinuation(user.id);
    const resetLocked = deferred();
    const releaseReset = deferred();
    const reset = revokeAllRefreshTokensForUser(user.id, {
      prisma: handle.prisma,
      afterUserLock: async () => {
        resetLocked.resolve();
        await releaseReset.promise;
      },
    });
    await resetLocked.promise;

    const completion = complete(signingToken);
    await expectStillPending(completion);
    releaseReset.resolve();

    await expect(reset).resolves.toBeUndefined();
    await expect(completion).rejects.toMatchObject({
      statusCode: 401,
      message: 'AUTHENTICATION_FAILED',
    });
    expect(await handle.prisma.signingContinuation.findFirstOrThrow()).toMatchObject({
      consumedAt: null,
    });
    expect(await handle.prisma.authorizationCode.count()).toBe(0);
  });

  it('continuation-first mints a code that a waiting reset makes stale', async () => {
    const user = await seedUser();
    const signingToken = await seedContinuation(user.id);
    const completionLocked = deferred();
    const releaseCompletion = deferred();
    const completion = complete(signingToken, async () => {
      completionLocked.resolve();
      await releaseCompletion.promise;
    });
    await completionLocked.promise;

    const reset = revokeAllRefreshTokensForUser(user.id, { prisma: handle.prisma });
    await expectStillPending(reset);
    releaseCompletion.resolve();

    const completed = await completion;
    expect(completed.status).toBe('granted');
    if (completed.status !== 'granted') throw new Error('continuation did not complete');
    await expect(reset).resolves.toBeUndefined();
    await expect(exchange(completed.code)).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_AUTH_CODE',
    });
    expect(await handle.prisma.signingContinuation.findFirstOrThrow()).toMatchObject({
      consumedAt: expect.any(Date),
    });
    expect(await handle.prisma.authorizationCode.findFirstOrThrow()).toMatchObject({
      usedAt: null,
    });
    expect(await handle.prisma.refreshToken.count()).toBe(0);
  });
});
