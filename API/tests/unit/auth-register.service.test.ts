import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/config/env.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { requestRegistrationInstructions } from '../../src/services/auth-register.service.js';
import { testUiTheme } from '../helpers/test-config.js';

type PrismaUserFindUniqueArgs = {
  where: { userKey: string };
  select: { id: true };
};

type PrismaVerificationTokenCreateArgs = {
  data: Record<string, unknown>;
};

type PrismaStub = {
  user: {
    findUnique: (args: PrismaUserFindUniqueArgs) => Promise<{ id: string } | null>;
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
    SHARED_SECRET: 'test-shared-secret',
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

describe('requestRegistrationInstructions', () => {
  it('creates a LOGIN_LINK token and sends a login link for an existing user', async () => {
    const findUnique = vi
      .fn<PrismaStub['user']['findUnique']>()
      .mockResolvedValue({ id: 'u1' });
    const createToken = vi
      .fn<PrismaStub['verificationToken']['create']>()
      .mockResolvedValue({ id: 't1' });
    const prisma: PrismaStub = {
      user: { findUnique },
      verificationToken: { create: createToken },
    };

    const sendLoginLinkEmail = vi.fn<(params: { to: string; link: string }) => Promise<void>>(
      async () => undefined,
    );
    const sendVerifyEmailSetPasswordEmail = vi.fn<
      (params: { to: string; link: string }) => Promise<void>
    >(async () => undefined);

    await requestRegistrationInstructions(
      {
        email: 'existing@example.com',
        config: baseConfig(),
        configUrl: 'https://client.example.com/auth-config',
      },
      {
        env: testEnv(),
        prisma,
        sharedSecret: 'pepper',
        now: () => new Date('2026-02-10T00:00:00.000Z'),
        generateEmailToken: () => 'token123',
        hashEmailToken: () => 'hash123',
        sendLoginLinkEmail,
        sendVerifyEmailSetPasswordEmail,
      },
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: { userKey: 'existing@example.com' },
      select: { id: true },
    });

    expect(createToken).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'LOGIN_LINK',
        email: 'existing@example.com',
        userKey: 'existing@example.com',
        domain: null,
        configUrl: 'https://client.example.com/auth-config',
        tokenHash: 'hash123',
        userId: 'u1',
      }),
    });

    expect(sendLoginLinkEmail).toHaveBeenCalledWith({
      to: 'existing@example.com',
      link: 'https://auth.example.com/auth/email/login-link?token=token123&config_url=https%3A%2F%2Fclient.example.com%2Fauth-config',
    });
    expect(sendVerifyEmailSetPasswordEmail).not.toHaveBeenCalled();
  });

  it('creates a VERIFY_EMAIL_SET_PASSWORD token and sends verification instructions for a new user', async () => {
    const findUnique = vi
      .fn<PrismaStub['user']['findUnique']>()
      .mockResolvedValue(null);
    const createToken = vi
      .fn<PrismaStub['verificationToken']['create']>()
      .mockResolvedValue({ id: 't2' });
    const prisma: PrismaStub = {
      user: { findUnique },
      verificationToken: { create: createToken },
    };

    const sendLoginLinkEmail = vi.fn<(params: { to: string; link: string }) => Promise<void>>(
      async () => undefined,
    );
    const sendVerifyEmailSetPasswordEmail = vi.fn<
      (params: { to: string; link: string }) => Promise<void>
    >(async () => undefined);

    await requestRegistrationInstructions(
      {
        email: 'new@example.com',
        config: baseConfig({ user_scope: 'per_domain' }),
        configUrl: 'https://client.example.com/auth-config',
      },
      {
        env: testEnv(),
        prisma,
        sharedSecret: 'pepper',
        now: () => new Date('2026-02-10T00:00:00.000Z'),
        generateEmailToken: () => 'token456',
        hashEmailToken: () => 'hash456',
        sendLoginLinkEmail,
        sendVerifyEmailSetPasswordEmail,
      },
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: { userKey: 'client.example.com|new@example.com' },
      select: { id: true },
    });

    expect(createToken).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'VERIFY_EMAIL_SET_PASSWORD',
        email: 'new@example.com',
        userKey: 'client.example.com|new@example.com',
        domain: 'client.example.com',
        configUrl: 'https://client.example.com/auth-config',
        tokenHash: 'hash456',
        userId: null,
      }),
    });

    expect(sendVerifyEmailSetPasswordEmail).toHaveBeenCalledWith({
      to: 'new@example.com',
      link: 'https://auth.example.com/auth/email/verify-set-password?token=token456&config_url=https%3A%2F%2Fclient.example.com%2Fauth-config',
    });
    expect(sendLoginLinkEmail).not.toHaveBeenCalled();
  });

  it('is a no-op when the database is disabled', async () => {
    const findUnique = vi.fn<PrismaStub['user']['findUnique']>();
    const createToken = vi.fn<PrismaStub['verificationToken']['create']>();
    const prisma: PrismaStub = {
      user: { findUnique },
      verificationToken: { create: createToken },
    };

    const sendLoginLinkEmail = vi.fn<(params: { to: string; link: string }) => Promise<void>>(
      async () => undefined,
    );

    await requestRegistrationInstructions(
      {
        email: 'any@example.com',
        config: baseConfig(),
        configUrl: 'https://client.example.com/auth-config',
      },
      {
        env: testEnv({ DATABASE_URL: undefined, PUBLIC_BASE_URL: undefined }),
        prisma,
        sendLoginLinkEmail,
      },
    );

    expect(findUnique).not.toHaveBeenCalled();
    expect(createToken).not.toHaveBeenCalled();
    expect(sendLoginLinkEmail).not.toHaveBeenCalled();
  });
});
