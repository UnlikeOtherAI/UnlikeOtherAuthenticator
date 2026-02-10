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
import { encryptTwoFaSecret } from '../../src/utils/twofa-secret.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

async function createSignedConfigJwt(sharedSecret: string): Promise<string> {
  const aud = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
  return await new SignJWT(baseClientConfigPayload({ user_scope: 'global', '2fa_enabled': true }))
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(aud)
    .sign(new TextEncoder().encode(sharedSecret));
}

describe('POST /2fa/reset/request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('always responds with the same success message (no enumeration)', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response(jwt, { status: 200 })),
    );

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const url = `/2fa/reset/request?config_url=${encodeURIComponent(configUrl)}`;

    const res1 = await app.inject({
      method: 'POST',
      url,
      payload: { email: 'existing@example.com' },
    });
    const res2 = await app.inject({
      method: 'POST',
      url,
      payload: { email: 'missing@example.com' },
    });
    const res3 = await app.inject({
      method: 'POST',
      url,
      payload: { email: 'not-an-email' },
    });
    const res4 = await app.inject({
      method: 'POST',
      url,
      payload: {},
    });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res3.statusCode).toBe(200);
    expect(res4.statusCode).toBe(200);

    const expected = { message: 'We sent instructions to your email' };
    expect(res1.json()).toEqual(expected);
    expect(res2.json()).toEqual(expected);
    expect(res3.json()).toEqual(expected);
    expect(res4.json()).toEqual(expected);

    await app.close();
  });
});

describe.skipIf(!hasDatabase)('2FA reset flow', () => {
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

  it('resets 2FA on GET email link (one-time token)', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(jwt, { status: 200 })));

    const configUrl = 'https://client.example.com/auth-config';
    const rawToken = 'twofa-reset-token';
    const tokenHash = hashEmailToken(rawToken, process.env.SHARED_SECRET);

    const encrypted = encryptTwoFaSecret({
      secret: 'JBSWY3DPEHPK3PXP',
      sharedSecret: process.env.SHARED_SECRET,
    });

    const user = await handle!.prisma.user.create({
      data: {
        email: 'user@example.com',
        userKey: 'user@example.com',
        domain: null,
        twoFaEnabled: true,
        twoFaSecret: encrypted,
      },
      select: { id: true },
    });

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await handle!.prisma.verificationToken.create({
      data: {
        type: 'TWOFA_RESET',
        email: 'user@example.com',
        userKey: 'user@example.com',
        domain: null,
        configUrl,
        tokenHash,
        expiresAt,
        userId: user.id,
      },
    });

    const app = await createApp();
    await app.ready();

    const baseQuery = `config_url=${encodeURIComponent(configUrl)}`;
    const landing = await app.inject({
      method: 'GET',
      url: `/auth/email/twofa-reset?${baseQuery}&token=${encodeURIComponent(rawToken)}`,
    });

    expect(landing.statusCode).toBe(200);
    expect(landing.json()).toEqual({ ok: true });

    const updatedUser = await handle!.prisma.user.findUnique({
      where: { userKey: 'user@example.com' },
      select: { id: true, twoFaEnabled: true, twoFaSecret: true },
    });
    expect(updatedUser).not.toBeNull();
    expect(updatedUser!.id).toBe(user.id);
    expect(updatedUser!.twoFaEnabled).toBe(false);
    expect(updatedUser!.twoFaSecret).toBeNull();

    const tokenRow = await handle!.prisma.verificationToken.findUnique({
      where: { tokenHash },
      select: { usedAt: true, userId: true },
    });
    expect(tokenRow).not.toBeNull();
    expect(tokenRow!.usedAt).not.toBeNull();
    expect(tokenRow!.userId).toBe(user.id);

    // Second use should fail (one-time token).
    const reuse = await app.inject({
      method: 'GET',
      url: `/auth/email/twofa-reset?${baseQuery}&token=${encodeURIComponent(rawToken)}`,
    });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });
});
