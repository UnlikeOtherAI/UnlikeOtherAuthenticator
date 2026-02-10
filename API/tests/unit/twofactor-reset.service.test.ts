import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/config/env.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { requestTwoFaReset, resetTwoFaWithToken } from '../../src/services/twofactor-reset.service.js';

type PrismaUserFindUniqueArgs = {
  where: { userKey: string };
  select: Record<string, boolean>;
};

type PrismaUserUpdateArgs = {
  where: { userKey: string };
  data: Record<string, unknown>;
  select: { id: true };
};

type PrismaVerificationTokenFindUniqueArgs = {
  where: { tokenHash: string };
  select: Record<string, boolean>;
};

type PrismaVerificationTokenCreateArgs = {
  data: Record<string, unknown>;
};

type PrismaVerificationTokenUpdateManyArgs = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
};

type PrismaStub = {
  $transaction: <T>(fn: (tx: PrismaStub) => Promise<T>) => Promise<T>;
  user: {
    findUnique: (
      args: PrismaUserFindUniqueArgs,
    ) => Promise<{ id: string; twoFaEnabled?: boolean } | null>;
    update: (args: PrismaUserUpdateArgs) => Promise<{ id: string }>;
  };
  verificationToken: {
    findUnique: (
      args: PrismaVerificationTokenFindUniqueArgs,
    ) => Promise<{
      id: string;
      type: 'TWOFA_RESET' | string;
      userKey: string;
      configUrl: string;
      expiresAt: Date;
      usedAt: Date | null;
    } | null>;
    create: (args: PrismaVerificationTokenCreateArgs) => Promise<{ id: string }>;
    updateMany: (args: PrismaVerificationTokenUpdateManyArgs) => Promise<{ count: number }>;
  };
};

function testEnv(overrides?: Partial<Env>): Env {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 3000,
    PUBLIC_BASE_URL: 'https://auth.example.com',
    LOG_LEVEL: 'info',
    SHARED_SECRET: 'test-shared-secret',
    AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
    DATABASE_URL: 'postgres://example.invalid/db',
    ACCESS_TOKEN_TTL: '30m',
    LOG_RETENTION_DAYS: 90,
    ...overrides,
  };
}

function baseConfig(overrides?: Partial<ClientConfig>): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: {},
    language_config: 'en',
    user_scope: 'global',
    '2fa_enabled': false,
    debug_enabled: false,
    ...overrides,
  };
}

describe('requestTwoFaReset', () => {
  it('creates a TWOFA_RESET token and sends email for a user with 2FA enabled', async () => {
    const findUnique = vi
      .fn<PrismaStub['user']['findUnique']>()
      .mockResolvedValue({ id: 'u1', twoFaEnabled: true });
    const createToken = vi
      .fn<PrismaStub['verificationToken']['create']>()
      .mockResolvedValue({ id: 't1' });

    const prisma: PrismaStub = {
      $transaction: async (fn) => await fn(prisma),
      user: { findUnique, update: vi.fn() as never },
      verificationToken: {
        findUnique: vi.fn() as never,
        create: createToken,
        updateMany: vi.fn() as never,
      },
    };

    const sendTwoFaResetEmail = vi.fn<(params: { to: string; link: string }) => Promise<void>>(
      async () => undefined,
    );

    await requestTwoFaReset(
      {
        email: 'existing@example.com',
        config: baseConfig(),
        configUrl: 'https://client.example.com/auth-config',
      },
      {
        env: testEnv(),
        prisma: prisma as unknown as never,
        sharedSecret: 'pepper',
        now: () => new Date('2026-02-10T00:00:00.000Z'),
        generateEmailToken: () => 'token123',
        hashEmailToken: () => 'hash123',
        sendTwoFaResetEmail,
      },
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: { userKey: 'existing@example.com' },
      select: { id: true, twoFaEnabled: true },
    });

    expect(createToken).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'TWOFA_RESET',
        email: 'existing@example.com',
        userKey: 'existing@example.com',
        domain: null,
        configUrl: 'https://client.example.com/auth-config',
        tokenHash: 'hash123',
        userId: 'u1',
      }),
    });

    expect(sendTwoFaResetEmail).toHaveBeenCalledWith({
      to: 'existing@example.com',
      link: 'https://auth.example.com/auth/email/twofa-reset?token=token123&config_url=https%3A%2F%2Fclient.example.com%2Fauth-config',
    });
  });

  it('does nothing for non-existent users or users without 2FA (no enumeration)', async () => {
    const findUnique = vi.fn<PrismaStub['user']['findUnique']>().mockResolvedValue(null);
    const createToken = vi.fn<PrismaStub['verificationToken']['create']>();

    const prisma: PrismaStub = {
      $transaction: async (fn) => await fn(prisma),
      user: { findUnique, update: vi.fn() as never },
      verificationToken: {
        findUnique: vi.fn() as never,
        create: createToken as never,
        updateMany: vi.fn() as never,
      },
    };

    const sendTwoFaResetEmail = vi.fn<(params: { to: string; link: string }) => Promise<void>>(
      async () => undefined,
    );

    await requestTwoFaReset(
      {
        email: 'missing@example.com',
        config: baseConfig({ user_scope: 'per_domain' }),
        configUrl: 'https://client.example.com/auth-config',
      },
      {
        env: testEnv(),
        prisma: prisma as unknown as never,
        sendTwoFaResetEmail,
      },
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: { userKey: 'client.example.com|missing@example.com' },
      select: { id: true, twoFaEnabled: true },
    });

    expect(createToken).not.toHaveBeenCalled();
    expect(sendTwoFaResetEmail).not.toHaveBeenCalled();
  });

  it('is a no-op when the database is disabled', async () => {
    const prisma: PrismaStub = {
      $transaction: async (fn) => await fn(prisma),
      user: { findUnique: vi.fn() as never, update: vi.fn() as never },
      verificationToken: {
        findUnique: vi.fn() as never,
        create: vi.fn() as never,
        updateMany: vi.fn() as never,
      },
    };

    const sendTwoFaResetEmail = vi.fn<(params: { to: string; link: string }) => Promise<void>>(
      async () => undefined,
    );

    await requestTwoFaReset(
      {
        email: 'any@example.com',
        config: baseConfig(),
        configUrl: 'https://client.example.com/auth-config',
      },
      {
        env: testEnv({ DATABASE_URL: undefined, PUBLIC_BASE_URL: undefined }),
        prisma: prisma as unknown as never,
        sendTwoFaResetEmail,
      },
    );

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.verificationToken.create).not.toHaveBeenCalled();
    expect(sendTwoFaResetEmail).not.toHaveBeenCalled();
  });
});

describe('resetTwoFaWithToken', () => {
  it('consumes token, disables 2FA, and marks the token as used', async () => {
    const prisma: PrismaStub = {
      $transaction: async (fn) => await fn(prisma),
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: 'u1' }),
        update: vi.fn().mockResolvedValue({ id: 'u1' }),
      },
      verificationToken: {
        findUnique: vi.fn().mockResolvedValue({
          id: 't1',
          type: 'TWOFA_RESET',
          userKey: 'user@example.com',
          configUrl: 'https://client.example.com/auth-config',
          expiresAt: new Date('2026-02-10T00:30:00.000Z'),
          usedAt: null,
        }),
        create: vi.fn() as never,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const res = await resetTwoFaWithToken(
      {
        token: 'raw-token',
        configUrl: 'https://client.example.com/auth-config',
        config: baseConfig(),
      },
      {
        env: testEnv(),
        prisma: prisma as unknown as never,
        now: () => new Date('2026-02-10T00:00:00.000Z'),
        sharedSecret: 'pepper',
        hashEmailToken: () => 'hash123',
      },
    );

    expect(res).toEqual({ userId: 'u1' });

    expect(prisma.verificationToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: 'hash123' },
      select: {
        id: true,
        type: true,
        userKey: true,
        configUrl: true,
        expiresAt: true,
        usedAt: true,
      },
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { userKey: 'user@example.com' },
      data: { twoFaEnabled: false, twoFaSecret: null },
      select: { id: true },
    });

    expect(prisma.verificationToken.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 't1',
        usedAt: null,
      }),
      data: expect.objectContaining({
        userId: 'u1',
      }),
    });
  });
});
