import { createHash } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { jwtVerify } from 'jose';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/jwt.js';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/services/password.service.js';
import { createClientId } from '../../src/utils/hash.js';
import { expectJsonError } from '../helpers/error-response.js';
import { createTestDb } from '../helpers/test-db.js';
import { createTestConfigFetchHandler, signTestConfigJwt } from '../helpers/test-config.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const configUrl = 'https://client.example.com/auth-config';
const redirectUrl = 'https://client.example.com/oauth/callback';
const userEmail = 'user@example.com';
const userPassword = 'Abcdef1!';

type TokenBody = {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  token_type: string;
};

async function createSignedConfigJwt(sharedSecret: string): Promise<string> {
  void sharedSecret;
  return await signTestConfigJwt();
}

function authorizationHeader(): string {
  return `Bearer ${createClientId('client.example.com', process.env.SHARED_SECRET!)}`;
}

function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
}

describe.skipIf(!hasDatabase)('POST /auth/token', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAud = process.env.AUTH_SERVICE_IDENTIFIER;
  const originalTtl = process.env.ACCESS_TOKEN_TTL;
  const originalRefreshTokenTtlDays = process.env.REFRESH_TOKEN_TTL_DAYS;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalAud;
    process.env.ACCESS_TOKEN_TTL = originalTtl;
    process.env.REFRESH_TOKEN_TTL_DAYS = originalRefreshTokenTtlDays;
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    process.env.ACCESS_TOKEN_TTL = '15m';
    process.env.REFRESH_TOKEN_TTL_DAYS = '30';

    if (!handle) return;
    await handle.prisma.refreshToken.deleteMany();
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.verificationToken.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function seedUser() {
    const passwordHash = await hashPassword(userPassword);
    return await handle!.prisma.user.create({
      data: {
        email: userEmail,
        userKey: userEmail,
        passwordHash,
      },
      select: { id: true },
    });
  }

  async function createConfiguredApp() {
    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET!);
    const fetchMock = vi.fn(await createTestConfigFetchHandler(jwt));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();
    return { app, fetchMock };
  }

  async function issueAuthorizationCode(
    app: Awaited<ReturnType<typeof createApp>>,
    pkce?: { codeChallenge: string },
  ): Promise<string> {
    const url = new URL('/auth/login', 'http://localhost');
    url.searchParams.set('config_url', configUrl);
    url.searchParams.set('redirect_url', redirectUrl);
    if (pkce) {
      url.searchParams.set('code_challenge', pkce.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }

    const loginRes = await app.inject({
      method: 'POST',
      url: `${url.pathname}${url.search}`,
      payload: { email: userEmail, password: userPassword },
    });
    expect(loginRes.statusCode).toBe(200);
    const { code } = loginRes.json() as { code: string };
    return code;
  }

  async function exchangeAuthorizationCode(
    app: Awaited<ReturnType<typeof createApp>>,
    code: string,
    codeVerifier?: string,
  ) {
    return await app.inject({
      method: 'POST',
      url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
      headers: {
        authorization: authorizationHeader(),
      },
      payload: { code, redirect_url: redirectUrl, code_verifier: codeVerifier },
    });
  }

  async function issueTokenPair(app: Awaited<ReturnType<typeof createApp>>): Promise<TokenBody> {
    const code = await issueAuthorizationCode(app);
    const tokenRes = await exchangeAuthorizationCode(app, code);
    expect(tokenRes.statusCode).toBe(200);
    return tokenRes.json() as TokenBody;
  }

  async function exchangeRefreshToken(
    app: Awaited<ReturnType<typeof createApp>>,
    refreshToken: string,
  ) {
    return await app.inject({
      method: 'POST',
      url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
      headers: {
        authorization: authorizationHeader(),
      },
      payload: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      },
    });
  }

  it('exchanges a one-time authorization code for an access token and refresh token pair', async () => {
    const created = await seedUser();
    const { app, fetchMock } = await createConfiguredApp();

    const tokenBody = await issueTokenPair(app);

    expect(tokenBody).toMatchObject({
      token_type: 'Bearer',
      expires_in: 15 * 60,
      refresh_token_expires_in: 30 * 24 * 60 * 60,
    });
    expect(tokenBody.access_token.length).toBeGreaterThan(20);
    expect(tokenBody.refresh_token.length).toBeGreaterThan(20);

    const { payload } = await jwtVerify(
      tokenBody.access_token,
      new TextEncoder().encode(process.env.SHARED_SECRET!),
      { issuer: process.env.AUTH_SERVICE_IDENTIFIER, audience: ACCESS_TOKEN_AUDIENCE },
    );

    expect(payload.sub).toBe(created.id);
    expect(payload.email).toBe(userEmail);
    expect(payload.domain).toBe('client.example.com');
    expect(payload.client_id).toBe(
      createClientId('client.example.com', process.env.SHARED_SECRET!),
    );
    expect(payload.role).toBe('superuser');
    expect(typeof payload.exp).toBe('number');

    const roleRows = await handle!.prisma.domainRole.findMany({
      where: { domain: 'client.example.com', userId: created.id },
      select: { role: true },
    });
    expect(roleRows).toHaveLength(1);

    const codes = await handle!.prisma.authorizationCode.findMany({
      where: { userId: created.id },
      select: { usedAt: true },
    });
    expect(codes).toHaveLength(1);
    expect(codes[0]?.usedAt).not.toBeNull();

    const refreshTokens = await handle!.prisma.refreshToken.findMany({
      where: { userId: created.id },
      select: {
        tokenHash: true,
        revokedAt: true,
        replacedByTokenId: true,
      },
    });
    expect(refreshTokens).toHaveLength(1);
    expect(refreshTokens[0]?.tokenHash).not.toBe(tokenBody.refresh_token);
    expect(refreshTokens[0]?.revokedAt).toBeNull();
    expect(refreshTokens[0]?.replacedByTokenId).toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it('rejects malformed refresh-token requests', async () => {
    await seedUser();
    const { app } = await createConfiguredApp();

    const tokenRes = await app.inject({
      method: 'POST',
      url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
      headers: {
        authorization: authorizationHeader(),
      },
      payload: {
        grant_type: 'refresh_token',
      },
    });

    expect(tokenRes.statusCode).toBe(400);
    expectJsonError(tokenRes.json());

    await app.close();
  });

  it('rotates refresh tokens on refresh exchange', async () => {
    await seedUser();
    const { app } = await createConfiguredApp();

    const firstPair = await issueTokenPair(app);
    const refreshRes = await exchangeRefreshToken(app, firstPair.refresh_token);

    expect(refreshRes.statusCode).toBe(200);
    const secondPair = refreshRes.json() as TokenBody;
    expect(secondPair.refresh_token).not.toBe(firstPair.refresh_token);

    const refreshTokens = await handle!.prisma.refreshToken.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        parentTokenId: true,
        replacedByTokenId: true,
        revokedAt: true,
        lastUsedAt: true,
      },
    });

    expect(refreshTokens).toHaveLength(2);
    expect(refreshTokens[0]?.replacedByTokenId).toBe(refreshTokens[1]?.id);
    expect(refreshTokens[0]?.revokedAt).not.toBeNull();
    expect(refreshTokens[0]?.lastUsedAt).not.toBeNull();
    expect(refreshTokens[1]?.parentTokenId).toBe(refreshTokens[0]?.id);
    expect(refreshTokens[1]?.revokedAt).toBeNull();

    await app.close();
  });

  it('revokes the full refresh-token family when an old token is reused', async () => {
    await seedUser();
    const { app } = await createConfiguredApp();

    const firstPair = await issueTokenPair(app);
    const rotatedRes = await exchangeRefreshToken(app, firstPair.refresh_token);
    expect(rotatedRes.statusCode).toBe(200);
    const secondPair = rotatedRes.json() as TokenBody;

    const reusedRes = await exchangeRefreshToken(app, firstPair.refresh_token);
    expect(reusedRes.statusCode).toBe(401);
    expectJsonError(reusedRes.json());

    const currentRes = await exchangeRefreshToken(app, secondPair.refresh_token);
    expect(currentRes.statusCode).toBe(401);
    expectJsonError(currentRes.json());

    const refreshTokens = await handle!.prisma.refreshToken.findMany({
      select: { revokedAt: true },
    });
    expect(refreshTokens).toHaveLength(2);
    expect(refreshTokens.every((token) => token.revokedAt !== null)).toBe(true);

    await app.close();
  });

  it('rejects expired refresh tokens', async () => {
    await seedUser();
    const { app } = await createConfiguredApp();

    const firstPair = await issueTokenPair(app);
    await handle!.prisma.refreshToken.updateMany({
      data: {
        expiresAt: new Date('2026-03-10T00:00:00.000Z'),
      },
    });

    const refreshRes = await exchangeRefreshToken(app, firstPair.refresh_token);
    expect(refreshRes.statusCode).toBe(401);
    expectJsonError(refreshRes.json());

    await app.close();
  });

  it('revokes refresh tokens via /auth/revoke', async () => {
    await seedUser();
    const { app } = await createConfiguredApp();

    const firstPair = await issueTokenPair(app);
    const revokeRes = await app.inject({
      method: 'POST',
      url: `/auth/revoke?config_url=${encodeURIComponent(configUrl)}`,
      headers: {
        authorization: authorizationHeader(),
      },
      payload: {
        refresh_token: firstPair.refresh_token,
      },
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json()).toEqual({ ok: true });

    const refreshRes = await exchangeRefreshToken(app, firstPair.refresh_token);
    expect(refreshRes.statusCode).toBe(401);
    expectJsonError(refreshRes.json());

    const refreshTokens = await handle!.prisma.refreshToken.findMany({
      select: { revokedAt: true },
    });
    expect(refreshTokens).toHaveLength(1);
    expect(refreshTokens[0]?.revokedAt).not.toBeNull();

    await app.close();
  });

  it('rejects reusing the same code (one-time)', async () => {
    await seedUser();
    const { app } = await createConfiguredApp();

    const code = await issueAuthorizationCode(app);
    const first = await exchangeAuthorizationCode(app, code);
    expect(first.statusCode).toBe(200);

    const second = await exchangeAuthorizationCode(app, code);
    expect(second.statusCode).toBe(401);
    expectJsonError(second.json());

    await app.close();
  });

  it('requires a matching PKCE verifier for a challenged authorization code', async () => {
    await seedUser();
    const { app } = await createConfiguredApp();
    const codeVerifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    const code = await issueAuthorizationCode(app, {
      codeChallenge: pkceChallenge(codeVerifier),
    });

    const missingVerifier = await exchangeAuthorizationCode(app, code);
    expect(missingVerifier.statusCode).toBe(401);
    expectJsonError(missingVerifier.json());

    const wrongVerifier = await exchangeAuthorizationCode(app, code, `${codeVerifier}x`);
    expect(wrongVerifier.statusCode).toBe(401);
    expectJsonError(wrongVerifier.json());

    const correctVerifier = await exchangeAuthorizationCode(app, code, codeVerifier);
    expect(correctVerifier.statusCode).toBe(200);

    await app.close();
  });

  it('rejects exchanging a code without a domain-hash bearer token', async () => {
    await seedUser();
    const { app } = await createConfiguredApp();

    const code = await issueAuthorizationCode(app);
    const tokenRes = await app.inject({
      method: 'POST',
      url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
      payload: { code, redirect_url: redirectUrl },
    });
    expect(tokenRes.statusCode).toBe(401);
    expectJsonError(tokenRes.json());

    await app.close();
  });
});
