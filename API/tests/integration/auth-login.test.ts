import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/services/password.service.js';
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

describe.skipIf(!hasDatabase)('POST /auth/login', () => {
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
    if (!handle) return;
    await handle.prisma.verificationToken.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns 200 on correct credentials', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const passwordHash = await hashPassword('Abcdef1!');
    await handle!.prisma.user.create({
      data: {
        email: 'user@example.com',
        userKey: 'user@example.com',
        passwordHash,
      },
    });

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(jwt, { status: 200 })));

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'POST',
      url: `/auth/login?config_url=${encodeURIComponent(configUrl)}`,
      payload: { email: 'user@example.com', password: 'Abcdef1!' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    await app.close();
  });

  it('returns generic 401 for wrong password and unknown email (no enumeration)', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const passwordHash = await hashPassword('Abcdef1!');
    await handle!.prisma.user.create({
      data: {
        email: 'user@example.com',
        userKey: 'user@example.com',
        passwordHash,
      },
    });

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(jwt, { status: 200 })));

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const baseUrl = `/auth/login?config_url=${encodeURIComponent(configUrl)}`;

    const wrongPassword = await app.inject({
      method: 'POST',
      url: baseUrl,
      payload: { email: 'user@example.com', password: 'Wrongpass1!' },
    });
    const unknownEmail = await app.inject({
      method: 'POST',
      url: baseUrl,
      payload: { email: 'missing@example.com', password: 'Abcdef1!' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);

    expect(wrongPassword.json()).toEqual({ error: 'Request failed' });
    expect(unknownEmail.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });
});
