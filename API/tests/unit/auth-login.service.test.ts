import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/config/env.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { loginWithEmailPassword } from '../../src/services/auth-login.service.js';
import { testUiTheme } from '../helpers/test-config.js';

type PrismaUserFindUniqueArgs = {
  where: { userKey: string };
  select: { id: true; passwordHash: true };
};

type PrismaStub = {
  user: {
    findUnique: (args: PrismaUserFindUniqueArgs) => Promise<{
      id: string;
      passwordHash: string | null;
      twoFaEnabled: boolean;
    } | null>;
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

describe('loginWithEmailPassword', () => {
  it('returns userId on correct credentials (global scope)', async () => {
    const prisma: PrismaStub = {
      user: {
        findUnique: async (args) => {
          expect(args.where.userKey).toBe('user@example.com');
          return { id: 'u1', passwordHash: 'hash', twoFaEnabled: false };
        },
      },
    };

    const result = await loginWithEmailPassword(
      { email: 'User@Example.com', password: 'pw', config: baseConfig() },
      {
        env: testEnv(),
        prisma,
        verifyPassword: async (password, hash) => password === 'pw' && hash === 'hash',
      },
    );

    expect(result.userId).toBe('u1');
    expect(result.twoFaEnabled).toBe(false);
  });

  it('respects per_domain user scope when building the lookup key', async () => {
    const prisma: PrismaStub = {
      user: {
        findUnique: async (args) => {
          expect(args.where.userKey).toBe('client.example.com|user@example.com');
          return { id: 'u2', passwordHash: 'hash2', twoFaEnabled: true };
        },
      },
    };

    const result = await loginWithEmailPassword(
      {
        email: 'user@example.com',
        password: 'pw',
        config: baseConfig({ user_scope: 'per_domain' }),
      },
      {
        env: testEnv(),
        prisma,
        verifyPassword: async () => true,
      },
    );

    expect(result.userId).toBe('u2');
    expect(result.twoFaEnabled).toBe(true);
  });

  it('throws UNAUTHORIZED for wrong password', async () => {
    const prisma: PrismaStub = {
      user: {
        findUnique: async () => ({ id: 'u1', passwordHash: 'hash', twoFaEnabled: false }),
      },
    };

    await expect(
      loginWithEmailPassword(
        { email: 'user@example.com', password: 'wrong', config: baseConfig() },
        {
          env: testEnv(),
          prisma,
          verifyPassword: async () => false,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('throws UNAUTHORIZED for unknown user (no enumeration)', async () => {
    const prisma: PrismaStub = {
      user: {
        findUnique: async () => null,
      },
    };

    let sawNullHash = false;
    const verifyPassword = async (password: string, hash: string | null | undefined) => {
      expect(password).toBe('pw');
      expect(hash).toBe(null);
      sawNullHash = true;
      return false;
    };

    await expect(
      loginWithEmailPassword(
        { email: 'missing@example.com', password: 'pw', config: baseConfig() },
        {
          env: testEnv(),
          prisma,
          verifyPassword,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 401 });

    // Ensure we still run password verification logic even when the user doesn't exist.
    expect(sawNullHash).toBe(true);
  });

  it('throws INTERNAL when DATABASE_URL is not configured', async () => {
    const prisma: PrismaStub = {
      user: {
        findUnique: async () => null,
      },
    };

    await expect(
      loginWithEmailPassword(
        { email: 'user@example.com', password: 'pw', config: baseConfig() },
        {
          env: testEnv({ DATABASE_URL: undefined }),
          prisma,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});
