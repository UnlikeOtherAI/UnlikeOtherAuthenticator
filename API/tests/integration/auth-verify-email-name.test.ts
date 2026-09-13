import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { hashEmailToken } from '../../src/utils/verification-token.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const configUrl = 'https://client.example.com/auth-config';
const pkceQuery =
  '&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256';

/**
 * F6: registration by e-mail never asked for a name, so every account created that way showed
 * as "Unnamed member" in the products. The optional field may fill a blank name and nothing
 * else — an account that already has one must come out of this call unchanged.
 */
describe.skipIf(!hasDatabase)('POST /auth/verify-email optional name', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
  };

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    if (!handle) return;
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.verificationToken.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();

    const jwt = await signTestConfigJwt(baseClientConfigPayload({ user_scope: 'global' }));
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function seedSetPasswordToken(params: {
    email: string;
    rawToken: string;
    user?: { id: string; tokenVersion: number };
  }): Promise<void> {
    await handle!.prisma.verificationToken.create({
      data: {
        type: 'VERIFY_EMAIL_SET_PASSWORD',
        email: params.email,
        userKey: params.email,
        domain: null,
        configUrl,
        tokenHash: hashEmailToken(params.rawToken, process.env.SHARED_SECRET!),
        expiresAt: new Date(Date.now() + 10 * 60_000),
        userId: params.user?.id,
        tokenVersion: params.user?.tokenVersion,
      },
    });
  }

  it('stores the submitted name on an account that has none', async () => {
    const email = 'named-newcomer@example.com';
    await seedSetPasswordToken({ email, rawToken: 'name-token-new-user' });

    const app = await createApp();
    await app.ready();
    try {
      const verify = await app.inject({
        method: 'POST',
        url: `/auth/verify-email?config_url=${encodeURIComponent(configUrl)}${pkceQuery}`,
        payload: { token: 'name-token-new-user', password: 'Abcdef1!', name: '  Nessie Test A  ' },
      });
      expect(verify.statusCode, verify.body).toBe(200);

      const user = await handle!.prisma.user.findUnique({
        where: { userKey: email },
        select: { name: true },
      });
      // Trimmed, and actually persisted — the whole point of the field.
      expect(user?.name).toBe('Nessie Test A');
    } finally {
      await app.close();
    }
  });

  it('leaves an account that already has a name untouched', async () => {
    const email = 'already-named@example.com';
    const existing = await handle!.prisma.user.create({
      data: { email, userKey: email, name: 'Established Name' },
      select: { id: true, tokenVersion: true },
    });
    await seedSetPasswordToken({ email, rawToken: 'name-token-existing-user', user: existing });

    const app = await createApp();
    await app.ready();
    try {
      const verify = await app.inject({
        method: 'POST',
        url: `/auth/verify-email?config_url=${encodeURIComponent(configUrl)}${pkceQuery}`,
        payload: {
          token: 'name-token-existing-user',
          password: 'Abcdef1!',
          name: 'Impostor Name',
        },
      });
      expect(verify.statusCode, verify.body).toBe(200);

      const user = await handle!.prisma.user.findUnique({
        where: { id: existing.id },
        select: { name: true },
      });
      expect(user?.name).toBe('Established Name');
    } finally {
      await app.close();
    }
  });

  it('accepts a body without a name exactly as before', async () => {
    const email = 'anonymous-newcomer@example.com';
    await seedSetPasswordToken({ email, rawToken: 'name-token-absent' });

    const app = await createApp();
    await app.ready();
    try {
      const verify = await app.inject({
        method: 'POST',
        url: `/auth/verify-email?config_url=${encodeURIComponent(configUrl)}${pkceQuery}`,
        payload: { token: 'name-token-absent', password: 'Abcdef1!' },
      });
      expect(verify.statusCode, verify.body).toBe(200);

      const user = await handle!.prisma.user.findUnique({
        where: { userKey: email },
        select: { name: true },
      });
      expect(user?.name ?? null).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('refuses a name longer than the documented limit', async () => {
    await seedSetPasswordToken({ email: 'too-long@example.com', rawToken: 'name-token-too-long' });

    const app = await createApp();
    await app.ready();
    try {
      const verify = await app.inject({
        method: 'POST',
        url: `/auth/verify-email?config_url=${encodeURIComponent(configUrl)}${pkceQuery}`,
        payload: {
          token: 'name-token-too-long',
          password: 'Abcdef1!',
          name: 'x'.repeat(121),
        },
      });
      expect(verify.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
