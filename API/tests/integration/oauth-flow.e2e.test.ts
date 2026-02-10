import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { jwtVerify, SignJWT } from 'jose';

import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/services/password.service.js';
import { createClientId } from '../../src/utils/hash.js';
import { createTestDb } from '../helpers/test-db.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

async function createSignedConfigJwt(sharedSecret: string): Promise<string> {
  const aud = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
  return await new SignJWT(baseClientConfigPayload())
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(aud)
    .sign(new TextEncoder().encode(sharedSecret));
}

describe.skipIf(!hasDatabase)('E2E OAuth flow (config_url -> /auth -> login -> token exchange)', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAud = process.env.AUTH_SERVICE_IDENTIFIER;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalAud;
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    if (!handle) return;
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.verificationToken.deleteMany();
    await handle.prisma.loginLog.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('runs the full authorization code flow starting from config URL fetch', async () => {
    const passwordHash = await hashPassword('Abcdef1!');
    const created = await handle!.prisma.user.create({
      data: {
        email: 'user@example.com',
        userKey: 'user@example.com',
        passwordHash,
      },
      select: { id: true },
    });

    const configUrl = 'https://client.example.com/auth-config';
    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET!);

    const fetchMock = vi.fn().mockImplementation(async () => new Response(jwt, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();

    // 1) OAuth entrypoint fetches config from the client-provided config URL and renders UI.
    const authUiRes = await app.inject({
      method: 'GET',
      url: `/auth?config_url=${encodeURIComponent(configUrl)}`,
    });
    expect(authUiRes.statusCode).toBe(200);
    expect(authUiRes.headers['content-type']).toContain('text/html');
    expect(authUiRes.body).toContain('window.__UOA_CLIENT_CONFIG__');

    // 2) User authenticates and receives an authorization code and a redirect URL (popup would navigate).
    const loginRes = await app.inject({
      method: 'POST',
      url: `/auth/login?config_url=${encodeURIComponent(configUrl)}`,
      payload: { email: 'user@example.com', password: 'Abcdef1!' },
    });
    expect(loginRes.statusCode).toBe(200);
    const loginBody = loginRes.json() as { ok: boolean; code: string; redirect_to: string };
    expect(loginBody.ok).toBe(true);
    expect(typeof loginBody.code).toBe('string');
    expect(typeof loginBody.redirect_to).toBe('string');

    const redirect = new URL(loginBody.redirect_to);
    expect(redirect.origin).toBe('https://client.example.com');
    expect(redirect.pathname).toBe('/oauth/callback');
    expect(redirect.searchParams.get('code')).toBe(loginBody.code);
    // Brief 22.13: token is never returned directly to the frontend via the popup.
    expect(redirect.searchParams.get('access_token')).toBeNull();

    // 3) Client backend exchanges the code for an access token (JWT).
    const tokenRes = await app.inject({
      method: 'POST',
      url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
      headers: {
        authorization: `Bearer ${createClientId('client.example.com', process.env.SHARED_SECRET!)}`,
      },
      payload: { code: loginBody.code },
    });
    expect(tokenRes.statusCode).toBe(200);
    const tokenBody = tokenRes.json() as { access_token: string; token_type: string };
    expect(tokenBody.token_type).toBe('Bearer');
    expect(typeof tokenBody.access_token).toBe('string');
    expect(tokenBody.access_token.length).toBeGreaterThan(20);

    const { payload } = await jwtVerify(
      tokenBody.access_token,
      new TextEncoder().encode(process.env.SHARED_SECRET!),
      { issuer: process.env.AUTH_SERVICE_IDENTIFIER },
    );
    expect(payload.sub).toBe(created.id);
    expect(payload.email).toBe('user@example.com');
    expect(payload.domain).toBe('client.example.com');

    // Config must be fetched and verified at each step (no trust caching).
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe(configUrl);
      expect(call[1]).toEqual(expect.objectContaining({ method: 'GET' }));
    }

    await app.close();
  });
});
