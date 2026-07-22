import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/config/env.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import {
  requestPasswordReset,
  resetPasswordWithToken,
} from '../../src/services/auth-reset-password.service.js';
import { testUiTheme } from '../helpers/test-config.js';

type PrismaUserFindUniqueArgs = {
  where: { userKey: string };
  select: { id: true; tokenVersion: true };
};

type PrismaVerificationTokenCreateArgs = {
  data: Record<string, unknown>;
};

type PrismaStub = {
  user: {
    findUnique: (
      args: PrismaUserFindUniqueArgs,
    ) => Promise<{ id: string; tokenVersion: number } | null>;
  };
  verificationToken: {
    create: (args: PrismaVerificationTokenCreateArgs) => Promise<{ id: string }>;
  };
};

function testEnv(overrides?: Partial<Env>): Env {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 3000,
    PUBLIC_BASE_URL: 'https://auth.example.com',
    LOG_LEVEL: 'info',
    SHARED_SECRET: 'test-shared-secret-with-enough-length',
    AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
    DATABASE_URL: 'postgres://example.invalid/db',
    ACCESS_TOKEN_TTL: '30m',
    LOG_RETENTION_DAYS: 90,
    AI_TRANSLATION_PROVIDER: 'disabled',
    OPENAI_API_KEY: undefined,
    OPENAI_MODEL: undefined,
    ...overrides,
  };
}

function baseConfig(overrides?: Partial<ClientConfig>): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: testUiTheme(),
    language_config: 'en',
    user_scope: 'global',
    '2fa_enabled': false,
    debug_enabled: false,
    ...overrides,
  };
}

describe('requestPasswordReset', () => {
  it('creates a PASSWORD_RESET token and sends email for an existing user', async () => {
    const findUnique = vi
      .fn<PrismaStub['user']['findUnique']>()
      .mockResolvedValue({ id: 'u1', tokenVersion: 7 });
    const createToken = vi
      .fn<PrismaStub['verificationToken']['create']>()
      .mockResolvedValue({ id: 't1' });
    const prisma: PrismaStub = {
      user: { findUnique },
      verificationToken: { create: createToken },
    };

    const sendPasswordResetEmail = vi.fn<(params: { to: string; link: string }) => Promise<void>>(
      async () => undefined,
    );

    await requestPasswordReset(
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
        sendPasswordResetEmail,
      },
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: { userKey: 'existing@example.com' },
      select: { id: true, tokenVersion: true },
    });

    expect(createToken).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'PASSWORD_RESET',
        email: 'existing@example.com',
        userKey: 'existing@example.com',
        domain: null,
        configUrl: 'https://client.example.com/auth-config',
        tokenHash: 'hash123',
        userId: 'u1',
        tokenVersion: 7,
      }),
    });

    expect(sendPasswordResetEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'existing@example.com',
        link: 'https://auth.example.com/auth/email/reset-password?token=token123&config_url=https%3A%2F%2Fclient.example.com%2Fauth-config',
      }),
    );
  });

  it('does nothing for non-existent users (no enumeration) but burns timing budget', async () => {
    const findUnique = vi.fn<PrismaStub['user']['findUnique']>().mockResolvedValue(null);
    const createToken = vi.fn<PrismaStub['verificationToken']['create']>();
    const prisma: PrismaStub = {
      user: { findUnique },
      verificationToken: { create: createToken },
    };

    const sendPasswordResetEmail = vi.fn<(params: { to: string; link: string }) => Promise<void>>(
      async () => undefined,
    );
    // Inject a fake timing budget so the test doesn't pay the real Argon2 cost.
    const consumeAccountFlowTimingBudget = vi.fn<() => Promise<void>>(async () => undefined);

    await requestPasswordReset(
      {
        email: 'missing@example.com',
        config: baseConfig({ user_scope: 'per_domain' }),
        configUrl: 'https://client.example.com/auth-config',
      },
      {
        env: testEnv(),
        prisma: prisma as unknown as never,
        sendPasswordResetEmail,
        consumeAccountFlowTimingBudget,
      },
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: { userKey: 'client.example.com|missing@example.com' },
      select: { id: true, tokenVersion: true },
    });

    expect(createToken).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    // Brief 11: the not-exists branch must still burn comparable CPU.
    expect(consumeAccountFlowTimingBudget).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the database is disabled', async () => {
    const findUnique = vi.fn<PrismaStub['user']['findUnique']>();
    const createToken = vi.fn<PrismaStub['verificationToken']['create']>();
    const prisma: PrismaStub = {
      user: { findUnique },
      verificationToken: { create: createToken },
    };

    const sendPasswordResetEmail = vi.fn<(params: { to: string; link: string }) => Promise<void>>(
      async () => undefined,
    );

    await requestPasswordReset(
      {
        email: 'any@example.com',
        config: baseConfig(),
        configUrl: 'https://client.example.com/auth-config',
      },
      {
        env: testEnv({ DATABASE_URL: undefined, PUBLIC_BASE_URL: undefined }),
        prisma: prisma as unknown as never,
        sendPasswordResetEmail,
      },
    );

    expect(findUnique).not.toHaveBeenCalled();
    expect(createToken).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});

describe('resetPasswordWithToken', () => {
  function makeConsumePrisma(params?: {
    expiresAt?: Date;
    tokenVersion?: number | null;
    userTokenVersion?: number;
  }) {
    const userId = 'u1';
    const userKey = 'existing@example.com';
    const prisma = {
      $queryRaw: vi.fn(),
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: userId,
          tokenVersion: params?.userTokenVersion ?? 7,
          userKey,
        }),
        update: vi.fn().mockResolvedValue({ id: userId }),
      },
      verificationToken: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({
          id: 't1',
          type: 'PASSWORD_RESET',
          userKey,
          userId,
          tokenVersion: params?.tokenVersion === undefined ? 7 : params.tokenVersion,
          configUrl: 'https://client.example.com/auth-config',
          expiresAt: params?.expiresAt ?? new Date('2099-02-10T00:30:00.000Z'),
          usedAt: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    return {
      ...prisma,
      $transaction: async <T>(fn: (tx: typeof prisma) => Promise<T>) => await fn(prisma),
    };
  }

  it('rejects a sibling reset token from a superseded credential epoch', async () => {
    const prisma = makeConsumePrisma({ tokenVersion: 6, userTokenVersion: 7 });
    const revokeAllRefreshTokensForUser = vi.fn(async () => undefined);

    await expect(
      resetPasswordWithToken(
        {
          token: 'raw-token',
          password: 'new-password',
          config: baseConfig(),
          configUrl: 'https://client.example.com/auth-config',
        },
        {
          env: testEnv(),
          prisma: prisma as unknown as never,
          sharedSecret: 'pepper',
          hashEmailToken: () => 'hash123',
          hashPassword: async () => 'new-password-hash',
          revokeAllRefreshTokensForUser: revokeAllRefreshTokensForUser as never,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'INVALID_TOKEN' });

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.verificationToken.updateMany).not.toHaveBeenCalled();
    expect(revokeAllRefreshTokensForUser).not.toHaveBeenCalled();
  });

  it('rejects a reset token that expires while waiting for the user epoch lock', async () => {
    let currentNow = new Date('2026-02-10T00:00:00.000Z');
    const prisma = makeConsumePrisma({
      expiresAt: new Date('2026-02-10T00:00:01.000Z'),
    });
    const revokeAllRefreshTokensForUser = vi.fn(async () => undefined);

    await expect(
      resetPasswordWithToken(
        {
          token: 'raw-token',
          password: 'new-password',
          config: baseConfig(),
          configUrl: 'https://client.example.com/auth-config',
        },
        {
          env: testEnv(),
          prisma: prisma as unknown as never,
          sharedSecret: 'pepper',
          hashEmailToken: () => 'hash123',
          hashPassword: async () => 'new-password-hash',
          now: () => currentNow,
          afterRefreshSessionLock: async () => {
            currentNow = new Date('2026-02-10T00:00:02.000Z');
          },
          revokeAllRefreshTokensForUser: revokeAllRefreshTokensForUser as never,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'TOKEN_EXPIRED' });

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.verificationToken.updateMany).not.toHaveBeenCalled();
    expect(revokeAllRefreshTokensForUser).not.toHaveBeenCalled();
  });

  it('fails closed for a legacy existing-user token without an issue epoch', async () => {
    const prisma = makeConsumePrisma({ tokenVersion: null });

    await expect(
      resetPasswordWithToken(
        {
          token: 'raw-token',
          password: 'new-password',
          config: baseConfig(),
          configUrl: 'https://client.example.com/auth-config',
        },
        {
          env: testEnv(),
          prisma: prisma as unknown as never,
          sharedSecret: 'pepper',
          hashEmailToken: () => 'hash123',
          hashPassword: async () => 'new-password-hash',
        },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'INVALID_TOKEN' });

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.verificationToken.updateMany).not.toHaveBeenCalled();
  });
});
