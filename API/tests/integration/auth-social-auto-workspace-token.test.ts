import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { jwtVerify } from 'jose';

import { createApp } from '../../src/app.js';
import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { createAdminDomain } from '../../src/services/domain-secret.service.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const domain = 'client.example.com';
const configUrl = 'https://client.example.com/auth-config';
const redirectUrl = 'https://client.example.com/oauth/callback';
const codeVerifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const userEmail = 'single-workspace-social@example.com';

function pkceChallenge(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function inputUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

async function activeClaim(accessToken: string): Promise<unknown> {
  const { payload } = await jwtVerify(
    accessToken,
    new TextEncoder().encode(process.env.SHARED_SECRET!),
    {
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
      audience: ACCESS_TOKEN_AUDIENCE,
    },
  );
  return payload.active;
}

describe.skipIf(!hasDatabase)('social auto-selected workspace token flow', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
    CONFIG_JWKS_URL: process.env.CONFIG_JWKS_URL,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  };

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');

    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
    process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3000';
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (handle) await handle.cleanup();
  });

  it('binds the sole ACTIVE team to the code, access token, refresh row, and rotation', async () => {
    const domainAuth = await createAdminDomain(
      {
        domain,
        clientSecret: 'single-workspace-test-client-secret',
        actorEmail: 'integration-test@example.com',
      },
      { prisma: handle!.prisma },
    );
    const user = await handle!.prisma.user.create({
      data: { email: userEmail, userKey: userEmail },
      select: { id: true },
    });
    const organisation = await handle!.prisma.organisation.create({
      data: {
        domain,
        name: 'Single Workspace Org',
        slug: 'single-workspace-org',
        ownerId: user.id,
      },
      select: { id: true },
    });
    await handle!.prisma.orgMember.create({
      data: { orgId: organisation.id, userId: user.id, role: 'owner' },
    });
    const team = await handle!.prisma.team.create({
      data: {
        orgId: organisation.id,
        name: 'Only Team',
        slug: 'only-team',
        isDefault: true,
      },
      select: { id: true },
    });
    await handle!.prisma.teamMember.create({
      data: { teamId: team.id, userId: user.id, teamRole: 'owner' },
    });

    const configJwt = await signTestConfigJwt(
      baseClientConfigPayload({
        enabled_auth_methods: ['google'],
        allow_registration: true,
        login_flow: { email_code_enabled: false, workspace_selection: 'auto' },
        org_features: { enabled: true, user_needs_team: true },
      }),
    );
    const configFetch = await createTestConfigFetchHandler(configJwt);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = inputUrl(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'google-access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(
          JSON.stringify({
            email: userEmail,
            email_verified: true,
            name: 'Single Workspace User',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return await configFetch(input);
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();
    try {
      const challenge = pkceChallenge(codeVerifier);
      const socialStart = await app.inject({
        method: 'GET',
        url:
          `/auth/social/google?config_url=${encodeURIComponent(configUrl)}` +
          `&redirect_url=${encodeURIComponent(redirectUrl)}` +
          `&code_challenge=${challenge}&code_challenge_method=S256`,
      });
      const fetchedUrls = fetchMock.mock.calls.map(([input]) => inputUrl(input));
      expect(fetchedUrls).toContain(configUrl);
      expect(socialStart.statusCode, socialStart.body).toBe(302);
      const providerRedirect = new URL(socialStart.headers.location as string);
      const state = providerRedirect.searchParams.get('state');
      const setCookie = socialStart.headers['set-cookie'];
      const cookieHeader = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
      expect(state).toBeTruthy();
      expect(cookieHeader).toBeTruthy();

      const callback = await app.inject({
        method: 'GET',
        url: `/auth/callback/google?code=provider-code&state=${encodeURIComponent(state!)}`,
        headers: { cookie: cookieHeader! },
      });
      expect(callback.statusCode, callback.body).toBe(302);
      const callbackUrl = new URL(callback.headers.location as string);
      expect(callbackUrl.origin + callbackUrl.pathname).toBe(redirectUrl);
      expect(callbackUrl.searchParams.has('flow')).toBe(false);
      const code = callbackUrl.searchParams.get('code');
      expect(code).toBeTruthy();

      const storedCode = await handle!.prisma.authorizationCode.findFirstOrThrow({
        where: { userId: user.id, usedAt: null },
        select: { orgId: true, teamId: true },
      });
      expect(storedCode).toEqual({ orgId: organisation.id, teamId: team.id });

      const authorization = `Bearer ${domainAuth.clientHash}`;
      const tokenResponse = await app.inject({
        method: 'POST',
        url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
        headers: { authorization },
        payload: {
          code,
          redirect_url: redirectUrl,
          code_verifier: codeVerifier,
        },
      });
      expect(tokenResponse.statusCode, tokenResponse.body).toBe(200);
      const firstPair = tokenResponse.json() as {
        access_token: string;
        refresh_token: string;
      };
      const exactActive = { orgId: organisation.id, teamId: team.id };
      expect(await activeClaim(firstPair.access_token)).toEqual(exactActive);

      const firstRefreshRow = await handle!.prisma.refreshToken.findFirstOrThrow({
        where: { userId: user.id, revokedAt: null },
        select: { id: true, orgId: true, teamId: true },
      });
      expect(firstRefreshRow).toMatchObject(exactActive);

      const refreshResponse = await app.inject({
        method: 'POST',
        url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
        headers: { authorization },
        payload: {
          grant_type: 'refresh_token',
          refresh_token: firstPair.refresh_token,
        },
      });
      expect(refreshResponse.statusCode, refreshResponse.body).toBe(200);
      const rotatedPair = refreshResponse.json() as { access_token: string };
      expect(await activeClaim(rotatedPair.access_token)).toEqual(exactActive);

      const refreshRows = await handle!.prisma.refreshToken.findMany({
        where: { userId: user.id },
        select: { id: true, orgId: true, teamId: true, revokedAt: true },
      });
      expect(refreshRows).toHaveLength(2);
      expect(
        refreshRows.every((row) => row.orgId === organisation.id && row.teamId === team.id),
      ).toBe(true);
      expect(refreshRows.find((row) => row.id === firstRefreshRow.id)?.revokedAt).not.toBeNull();
      expect(refreshRows.find((row) => row.id !== firstRefreshRow.id)?.revokedAt).toBeNull();
    } finally {
      await app.close();
    }
  });
});
