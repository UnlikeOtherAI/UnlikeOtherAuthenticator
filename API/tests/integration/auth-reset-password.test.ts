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

import { createApp } from '../../src/app.js';
import { createTestDb } from '../helpers/test-db.js';
import { expectJsonError } from '../helpers/error-response.js';
import { hashEmailToken } from '../../src/utils/verification-token.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe('POST /auth/reset-password/request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('always responds with the same success message (no enumeration)', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    const jwt = await signTestConfigJwt(baseClientConfigPayload({ user_scope: 'global' }));

    vi.stubGlobal(
      'fetch',
      vi.fn(await createTestConfigFetchHandler(jwt)),
    );

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const url = `/auth/reset-password/request?config_url=${encodeURIComponent(configUrl)}`;

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

    const expected = { message: "If you have an account with us, we've sent you instructions" };
    expect(res1.json()).toEqual(expected);
    expect(res2.json()).toEqual(expected);
    expect(res3.json()).toEqual(expected);
    expect(res4.json()).toEqual(expected);

    await app.close();
  });
});

describe.skipIf(!hasDatabase)('Password reset flow', () => {
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

  it('validates the link on GET and resets password on POST (one-time token)', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await signTestConfigJwt(baseClientConfigPayload({ user_scope: 'global' }));
    vi.stubGlobal(
      'fetch',
      vi.fn(await createTestConfigFetchHandler(jwt)),
    );

    const configUrl = 'https://client.example.com/auth-config';
    const rawToken = 'reset-token-value';
    const tokenHash = hashEmailToken(rawToken, process.env.SHARED_SECRET);

    const user = await handle!.prisma.user.create({
      data: {
        email: 'existing@example.com',
        userKey: 'existing@example.com',
        domain: null,
        passwordHash: 'old-hash',
      },
      select: { id: true },
    });

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await handle!.prisma.verificationToken.create({
      data: {
        type: 'PASSWORD_RESET',
        email: 'existing@example.com',
        userKey: 'existing@example.com',
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
      url: `/auth/email/reset-password?${baseQuery}&token=${encodeURIComponent(rawToken)}`,
    });

    expect(landing.statusCode).toBe(200);
    expect(landing.json()).toEqual({ ok: true });

    const reset = await app.inject({
      method: 'POST',
      url: `/auth/reset-password?${baseQuery}`,
      payload: { token: rawToken, password: 'Abcdef1!' },
    });

    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ ok: true });

    const updatedUser = await handle!.prisma.user.findUnique({
      where: { userKey: 'existing@example.com' },
      select: { id: true, passwordHash: true },
    });
    expect(updatedUser).not.toBeNull();
    expect(updatedUser!.id).toBe(user.id);
    expect(updatedUser!.passwordHash).toBeTruthy();
    expect(updatedUser!.passwordHash).not.toBe('old-hash');
    expect(updatedUser!.passwordHash!.startsWith('$argon2id$')).toBe(true);

    const tokenRow = await handle!.prisma.verificationToken.findUnique({
      where: { tokenHash },
      select: { usedAt: true, userId: true },
    });
    expect(tokenRow).not.toBeNull();
    expect(tokenRow!.usedAt).not.toBeNull();
    expect(tokenRow!.userId).toBe(user.id);

    // Second use should fail (one-time token).
    const reuse = await app.inject({
      method: 'POST',
      url: `/auth/reset-password?${baseQuery}`,
      payload: { token: rawToken, password: 'Abcdef1!' },
    });
    expect(reuse.statusCode).toBe(400);
    expectJsonError(reuse.json());

    await app.close();
  });

  it('returns generic 400 for invalid tokens', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await signTestConfigJwt(baseClientConfigPayload({ user_scope: 'global' }));
    vi.stubGlobal(
      'fetch',
      vi.fn(await createTestConfigFetchHandler(jwt)),
    );

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const baseQuery = `config_url=${encodeURIComponent(configUrl)}`;

    const res = await app.inject({
      method: 'POST',
      url: `/auth/reset-password?${baseQuery}`,
      payload: { token: 'does-not-exist', password: 'Abcdef1!' },
    });

    expect(res.statusCode).toBe(400);
    expectJsonError(res.json());

    await app.close();
  });
});
