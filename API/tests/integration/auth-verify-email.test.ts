import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { SignJWT } from 'jose';

import { createApp } from '../../src/app.js';
import { createTestDb } from '../helpers/test-db.js';
import { hashEmailToken } from '../../src/utils/verification-token.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

async function createSignedConfigJwt(sharedSecret: string): Promise<string> {
  const aud = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
  return await new SignJWT(baseClientConfigPayload({ user_scope: 'global' }))
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(aud)
    .sign(new TextEncoder().encode(sharedSecret));
}

describe.skipIf(!hasDatabase)('Email verification flow', () => {
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
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.verificationToken.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('validates the link on GET and creates a user on POST (one-time token)', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(jwt, { status: 200 })));

    const configUrl = 'https://client.example.com/auth-config';
    const rawToken = 'test-token-value';
    const tokenHash = hashEmailToken(rawToken, process.env.SHARED_SECRET);

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await handle!.prisma.verificationToken.create({
      data: {
        type: 'VERIFY_EMAIL_SET_PASSWORD',
        email: 'newuser@example.com',
        userKey: 'newuser@example.com',
        domain: null,
        configUrl,
        tokenHash,
        expiresAt,
      },
    });

    const app = await createApp();
    await app.ready();

    const baseQuery = `config_url=${encodeURIComponent(configUrl)}`;

    const landing = await app.inject({
      method: 'GET',
      url: `/auth/email/verify-set-password?${baseQuery}&token=${encodeURIComponent(rawToken)}`,
    });

    expect(landing.statusCode).toBe(200);
    expect(landing.json()).toEqual({ ok: true });

    const verify = await app.inject({
      method: 'POST',
      url: `/auth/verify-email?${baseQuery}`,
      payload: { token: rawToken, password: 'Abcdef1!' },
    });

    expect(verify.statusCode).toBe(200);
    const body = verify.json() as { ok: boolean; code: string; redirect_to: string };
    expect(body.ok).toBe(true);
    expect(typeof body.code).toBe('string');
    expect(body.code.length).toBeGreaterThan(10);

    const u = new URL(body.redirect_to);
    expect(`${u.origin}${u.pathname}`).toBe('https://client.example.com/oauth/callback');
    expect(u.searchParams.get('code')).toBe(body.code);

    const user = await handle!.prisma.user.findUnique({
      where: { userKey: 'newuser@example.com' },
      select: { id: true, email: true, passwordHash: true },
    });
    expect(user).not.toBeNull();
    expect(user!.email).toBe('newuser@example.com');
    expect(user!.passwordHash).toBeTruthy();

    const tokenRow = await handle!.prisma.verificationToken.findUnique({
      where: { tokenHash },
      select: { usedAt: true, userId: true },
    });
    expect(tokenRow).not.toBeNull();
    expect(tokenRow!.usedAt).not.toBeNull();
    expect(tokenRow!.userId).toBe(user!.id);

    const roles = await handle!.prisma.domainRole.findMany({
      where: { domain: 'client.example.com' },
      select: { role: true, userId: true },
    });
    expect(roles).toHaveLength(1);
    expect(roles[0].userId).toBe(user!.id);
    expect(roles[0].role).toBe('SUPERUSER');

    const codes = await handle!.prisma.authorizationCode.findMany({
      where: { userId: user!.id },
      select: { domain: true, configUrl: true, redirectUrl: true, usedAt: true },
    });
    expect(codes).toHaveLength(1);
    expect(codes[0].domain).toBe('client.example.com');
    expect(codes[0].configUrl).toBe(configUrl);
    expect(codes[0].redirectUrl).toBe('https://client.example.com/oauth/callback');
    expect(codes[0].usedAt).toBeNull();

    // Second use should fail (one-time token).
    const reuse = await app.inject({
      method: 'POST',
      url: `/auth/verify-email?${baseQuery}`,
      payload: { token: rawToken, password: 'Abcdef1!' },
    });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });

  it('returns generic 400 for invalid tokens', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(jwt, { status: 200 })));

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const baseQuery = `config_url=${encodeURIComponent(configUrl)}`;

    const res = await app.inject({
      method: 'POST',
      url: `/auth/verify-email?${baseQuery}`,
      payload: { token: 'does-not-exist', password: 'Abcdef1!' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });
});
