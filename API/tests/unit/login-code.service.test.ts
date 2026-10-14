import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { issueLoginCode, verifyLoginCode } from '../../src/services/login-code.service.js';
import { testUiTheme } from '../helpers/test-config.js';

function makeConfig(overrides?: Partial<ClientConfig>): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    login_flow: { email_code_enabled: true, team_selection: 'off' },
    ui_theme: testUiTheme(),
    language_config: 'en',
    user_scope: 'global',
    allow_registration: true,
    registration_mode: 'password_required',
    '2fa_enabled': false,
    debug_enabled: false,
    ...overrides,
  } as ClientConfig;
}

function makePrisma() {
  return {
    $queryRaw: vi.fn(),
    user: { findUnique: vi.fn() },
    verificationToken: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
  } as unknown as import('@prisma/client').PrismaClient;
}

function validLoginCodeRow(overrides?: Record<string, unknown>) {
  return {
    id: 'token-1',
    tokenHash: 'expected-hash',
    userId: 'user-1',
    userKey: 'jane@example.com',
    tokenVersion: 0,
    expiresAt: new Date('2099-03-01T00:10:00.000Z'),
    ...overrides,
  };
}

const baseEnv = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 3000,
  LOG_LEVEL: 'info',
  SHARED_SECRET: 'test-shared-secret-with-enough-length',
  AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
  DATABASE_URL: 'postgres://example.invalid/db',
  ACCESS_TOKEN_TTL: '30m',
  LOG_RETENTION_DAYS: 90,
  AI_TRANSLATION_PROVIDER: 'disabled',
  OPENAI_API_KEY: undefined,
  OPENAI_MODEL: undefined,
} as unknown as ReturnType<typeof import('../../src/config/env.js').getEnv>;

describe('login-code.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses disabled code authentication before reading or consuming a code', async () => {
    const prisma = makePrisma();
    const config = makeConfig({ login_flow: { email_code_enabled: false, team_selection: 'off' } });
    const input = { email: 'jane@example.com', config, configUrl: 'https://client.example.com/auth-config' };
    await expect(issueLoginCode(input, { env: baseEnv, prisma })).rejects.toMatchObject({ statusCode: 401 });
    await expect(verifyLoginCode({ ...input, code: '123456' }, { env: baseEnv, prisma })).rejects.toMatchObject({ statusCode: 401 });
    expect(prisma.verificationToken.findFirst).not.toHaveBeenCalled();
    expect(prisma.verificationToken.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['client.example.com', 'https://client.example.com/other-config'],
    ['other.example.com', 'https://client.example.com/auth-config'],
  ])('does not accept a globally scoped user code through another client context (%s)', async (domain, configUrl) => {
    const prisma = makePrisma();
    vi.mocked(prisma.verificationToken.findFirst).mockImplementation(async ({ where }) =>
      where?.domain === 'client.example.com' && where?.configUrl === 'https://client.example.com/auth-config'
        ? validLoginCodeRow() as never : null);
    await expect(verifyLoginCode({ email: 'jane@example.com', code: '123456', config: makeConfig({ domain }), configUrl },
      { env: baseEnv, prisma, hashEmailToken: () => 'expected-hash' })).rejects.toMatchObject({ statusCode: 401 });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.verificationToken.updateMany).not.toHaveBeenCalled();
  });

  describe('issueLoginCode', () => {
    it('returns silently and sends nothing when no user exists for (email, domain)', async () => {
      const prisma = makePrisma();
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const sendLoginCodeEmail = vi.fn(async () => undefined);

      await issueLoginCode(
        {
          email: 'nobody@example.com',
          config: makeConfig(),
          configUrl: 'https://client.example.com/auth-config',
        },
        { env: baseEnv, prisma, sendLoginCodeEmail },
      );

      expect(prisma.verificationToken.create).not.toHaveBeenCalled();
      expect(sendLoginCodeEmail).not.toHaveBeenCalled();
    });

    it('supersedes prior unused codes, creates a new hashed token, and emails the code', async () => {
      const prisma = makePrisma();
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ lifecycleStatus: 'ACTIVE',
        id: 'user-1',
        tokenVersion: 7,
      });
      (prisma.verificationToken.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({
        count: 1,
      });
      (prisma.verificationToken.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'token-1',
      });
      const sendLoginCodeEmail = vi.fn(async () => undefined);

      await issueLoginCode(
        {
          email: 'jane@example.com',
          config: makeConfig(),
          configUrl: 'https://client.example.com/auth-config',
        },
        {
          env: baseEnv,
          prisma,
          now: () => new Date('2026-03-01T00:00:00.000Z'),
          sharedSecret: 'test-shared-secret-with-enough-length',
          generateCode: () => '123456',
          sendLoginCodeEmail,
        },
      );

      expect(prisma.verificationToken.updateMany).toHaveBeenCalledWith({
        where: { userKey: 'jane@example.com', domain: 'client.example.com', configUrl: 'https://client.example.com/auth-config', type: 'LOGIN_CODE', usedAt: null },
        data: { usedAt: new Date('2026-03-01T00:00:00.000Z') },
      });
      expect(prisma.verificationToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'LOGIN_CODE',
          email: 'jane@example.com',
          userKey: 'jane@example.com',
          attemptCount: 0,
          userId: 'user-1',
          tokenVersion: 7,
        }),
      });
      expect(sendLoginCodeEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'jane@example.com', code: '123456' }),
      );
    });
  });

  describe('verifyLoginCode', () => {
    it('succeeds, marks the token used, and returns the userId', async () => {
      const prisma = makePrisma();
      (prisma.verificationToken.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        validLoginCodeRow({ expiresAt: new Date('2026-03-01T00:10:00.000Z') }),
      );
      (prisma.verificationToken.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({
        count: 1,
      });
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ lifecycleStatus: 'ACTIVE',
        id: 'user-1',
        tokenVersion: 0,
        userKey: 'jane@example.com',
      });

      const result = await verifyLoginCode(
        { email: 'jane@example.com', config: makeConfig(), code: '123456', configUrl: 'https://client.example.com/auth-config' },
        {
          env: baseEnv,
          prisma,
          now: () => new Date('2026-03-01T00:05:00.000Z'),
          sharedSecret: 'test-shared-secret-with-enough-length',
          hashEmailToken: () => 'expected-hash',
        },
      );

      expect(result).toEqual({ userId: 'user-1', credentialEpoch: 0 });
      expect(prisma.verificationToken.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'token-1',
          tokenVersion: 0,
          userId: 'user-1',
          usedAt: null,
          attemptCount: { lt: 5 },
          expiresAt: { gt: new Date('2026-03-01T00:05:00.000Z') },
        },
        data: { usedAt: new Date('2026-03-01T00:05:00.000Z') },
      });
    });

    it('increments attempt_count on a wrong code and throws the generic error', async () => {
      const prisma = makePrisma();
      (prisma.verificationToken.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        validLoginCodeRow(),
      );
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ lifecycleStatus: 'ACTIVE',
        id: 'user-1',
        tokenVersion: 0,
        userKey: 'jane@example.com',
      });

      let hashCallCount = 0;
      await expect(
        verifyLoginCode(
          { email: 'jane@example.com', config: makeConfig(), code: '000000', configUrl: 'https://client.example.com/auth-config' },
          {
            env: baseEnv,
            prisma,
            hashEmailToken: () => {
              hashCallCount += 1;
              return 'wrong-hash';
            },
          },
        ),
      ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });

      expect(hashCallCount).toBe(1);
      expect(prisma.verificationToken.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'token-1',
          tokenVersion: 0,
          userId: 'user-1',
          usedAt: null,
          attemptCount: { lt: 5 },
          expiresAt: { gt: expect.any(Date) },
        },
        data: { attemptCount: { increment: 1 } },
      });
    });

    it('commits five wrong guesses through a rollback-capable transaction and then refuses the right code', async () => {
      let attempts = 0;
      const prisma = makePrisma();
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ lifecycleStatus: 'ACTIVE', id: 'user-1', tokenVersion: 0, userKey: 'jane@example.com' });
      (prisma.verificationToken.findFirst as ReturnType<typeof vi.fn>).mockImplementation(async () => attempts < 5 ? validLoginCodeRow() : null);
      (prisma.verificationToken.updateMany as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }) => {
        if (data.attemptCount) attempts += 1;
        return { count: 1 };
      });
      prisma.$transaction = vi.fn(async (body) => {
        const before = attempts;
        const tx = { ...prisma, $transaction: undefined };
        try { return await body(tx); } catch (error) { attempts = before; throw error; }
      }) as never;
      for (let index = 0; index < 5; index += 1) {
        await expect(verifyLoginCode({ email: 'jane@example.com', config: makeConfig(), configUrl: 'https://client.example.com/auth-config', code: '000000' },
          { env: baseEnv, prisma, hashEmailToken: () => 'wrong-hash' })).rejects.toMatchObject({ statusCode: 401 });
      }
      expect(attempts).toBe(5);
      await expect(verifyLoginCode({ email: 'jane@example.com', config: makeConfig(), configUrl: 'https://client.example.com/auth-config', code: '123456' },
        { env: baseEnv, prisma, hashEmailToken: () => 'expected-hash' })).rejects.toMatchObject({ statusCode: 401 });
      expect(attempts).toBe(5);
    });

    it('excludes a 5th-attempt (dead) code from the lookup, giving the same generic error', async () => {
      const prisma = makePrisma();
      // A code with attemptCount >= 5 must never match the `attemptCount: { lt: 5 }` filter, so the
      // lookup finds nothing — simulate that directly.
      (prisma.verificationToken.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(
        verifyLoginCode(
          { email: 'jane@example.com', config: makeConfig(), code: '123456', configUrl: 'https://client.example.com/auth-config' },
          { env: baseEnv, prisma },
        ),
      ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    });

    it('gives the same generic error for an unknown/expired/used code (no token found)', async () => {
      const prisma = makePrisma();
      (prisma.verificationToken.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(
        verifyLoginCode(
          { email: 'unknown@example.com', config: makeConfig(), code: '999999', configUrl: 'https://client.example.com/auth-config' },
          { env: baseEnv, prisma },
        ),
      ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    });

    it('gives the same generic error when the token row has no linked user', async () => {
      const prisma = makePrisma();
      (prisma.verificationToken.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...validLoginCodeRow(),
        userId: null,
        tokenVersion: null,
      });

      await expect(
        verifyLoginCode(
          { email: 'jane@example.com', config: makeConfig(), code: '123456', configUrl: 'https://client.example.com/auth-config' },
          { env: baseEnv, prisma },
        ),
      ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    });

    it('fails generically when the concurrent single-use update loses the race', async () => {
      const prisma = makePrisma();
      (prisma.verificationToken.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        validLoginCodeRow(),
      );
      (prisma.verificationToken.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({
        count: 0,
      });
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ lifecycleStatus: 'ACTIVE',
        id: 'user-1',
        tokenVersion: 0,
        userKey: 'jane@example.com',
      });

      await expect(
        verifyLoginCode(
          { email: 'jane@example.com', config: makeConfig(), code: '123456', configUrl: 'https://client.example.com/auth-config' },
          { env: baseEnv, prisma, hashEmailToken: () => 'expected-hash' },
        ),
      ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    });

    it('rejects a login code issued in a superseded credential epoch', async () => {
      const prisma = makePrisma();
      (prisma.verificationToken.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        validLoginCodeRow(),
      );
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ lifecycleStatus: 'ACTIVE',
        id: 'user-1',
        tokenVersion: 1,
        userKey: 'jane@example.com',
      });

      await expect(
        verifyLoginCode(
          { email: 'jane@example.com', config: makeConfig(), code: '123456', configUrl: 'https://client.example.com/auth-config' },
          { env: baseEnv, prisma, hashEmailToken: () => 'expected-hash' },
        ),
      ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });

      expect(prisma.verificationToken.updateMany).not.toHaveBeenCalled();
    });

    it('fails closed for a legacy existing-user login code without an issue epoch', async () => {
      const prisma = makePrisma();
      (prisma.verificationToken.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        validLoginCodeRow({ tokenVersion: null }),
      );

      await expect(
        verifyLoginCode(
          { email: 'jane@example.com', config: makeConfig(), code: '123456', configUrl: 'https://client.example.com/auth-config' },
          { env: baseEnv, prisma, hashEmailToken: () => 'expected-hash' },
        ),
      ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });

      expect(prisma.verificationToken.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a login code that expires while waiting for the user epoch lock', async () => {
      const prisma = makePrisma();
      let currentNow = new Date('2026-03-01T00:00:00.000Z');
      (prisma.verificationToken.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        validLoginCodeRow({ expiresAt: new Date('2026-03-01T00:00:01.000Z') }),
      );
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ lifecycleStatus: 'ACTIVE',
        id: 'user-1',
        tokenVersion: 0,
        userKey: 'jane@example.com',
      });

      await expect(
        verifyLoginCode(
          { email: 'jane@example.com', config: makeConfig(), code: '123456', configUrl: 'https://client.example.com/auth-config' },
          {
            env: baseEnv,
            prisma,
            now: () => currentNow,
            hashEmailToken: () => 'expected-hash',
            afterUserLock: async () => {
              currentNow = new Date('2026-03-01T00:00:02.000Z');
            },
          },
        ),
      ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });

      expect(prisma.verificationToken.updateMany).not.toHaveBeenCalled();
    });
  });
});
