import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { jwtVerify, SignJWT } from 'jose';

import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/services/password.service.js';
import { createClientId } from '../../src/utils/hash.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

async function createSignedConfigJwt(sharedSecret: string): Promise<string> {
  const aud = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
  return await new SignJWT({
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: {},
    language_config: 'en',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(aud)
    .sign(new TextEncoder().encode(sharedSecret));
}

describe.skipIf(!hasDatabase)('POST /auth/token', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAud = process.env.AUTH_SERVICE_IDENTIFIER;
  const originalTtl = process.env.ACCESS_TOKEN_TTL;

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
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    process.env.ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL ?? '15m';

    if (!handle) return;
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.verificationToken.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exchanges a one-time authorization code for an access token JWT', async () => {
    const passwordHash = await hashPassword('Abcdef1!');
    const created = await handle!.prisma.user.create({
      data: {
        email: 'user@example.com',
        userKey: 'user@example.com',
        passwordHash,
      },
      select: { id: true },
    });

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET!);
    const fetchMock = vi.fn().mockResolvedValue(new Response(jwt, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const loginRes = await app.inject({
      method: 'POST',
      url: `/auth/login?config_url=${encodeURIComponent(configUrl)}`,
      payload: { email: 'user@example.com', password: 'Abcdef1!' },
    });
    expect(loginRes.statusCode).toBe(200);
    const loginBody = loginRes.json() as { ok: boolean; code: string };
    expect(loginBody.ok).toBe(true);
    expect(typeof loginBody.code).toBe('string');

    const tokenRes = await app.inject({
      method: 'POST',
      url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
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

    expect(fetchMock).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it('rejects reusing the same code (one-time)', async () => {
    const passwordHash = await hashPassword('Abcdef1!');
    await handle!.prisma.user.create({
      data: {
        email: 'user@example.com',
        userKey: 'user@example.com',
        passwordHash,
      },
    });

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET!);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(jwt, { status: 200 })));

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const loginRes = await app.inject({
      method: 'POST',
      url: `/auth/login?config_url=${encodeURIComponent(configUrl)}`,
      payload: { email: 'user@example.com', password: 'Abcdef1!' },
    });
    expect(loginRes.statusCode).toBe(200);
    const { code } = loginRes.json() as { code: string };

    const first = await app.inject({
      method: 'POST',
      url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
      payload: { code },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
      payload: { code },
    });
    expect(second.statusCode).toBe(401);
    expect(second.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });
});

