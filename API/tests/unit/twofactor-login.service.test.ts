import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/config/env.js';
import { verifyTwoFactorForLogin } from '../../src/services/twofactor-login.service.js';

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

describe('verifyTwoFactorForLogin', () => {
  it('verifies code for a 2FA-enabled user', async () => {
    const prisma = {
      user: {
        findUnique: async () => ({ twoFaEnabled: true, twoFaSecret: 'enc' }),
      },
    };

    await expect(
      verifyTwoFactorForLogin(
        { userId: 'u1', code: '123456' },
        {
          env: testEnv(),
          prisma,
          decryptTwoFaSecret: () => 'JBSWY3DPEHPK3PXP',
          verifyTotpCode: () => true,
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('throws UNAUTHORIZED when the code does not verify', async () => {
    const prisma = {
      user: {
        findUnique: async () => ({ twoFaEnabled: true, twoFaSecret: 'enc' }),
      },
    };

    await expect(
      verifyTwoFactorForLogin(
        { userId: 'u1', code: '000000' },
        {
          env: testEnv(),
          prisma,
          decryptTwoFaSecret: () => 'JBSWY3DPEHPK3PXP',
          verifyTotpCode: () => false,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('throws UNAUTHORIZED when user is missing or 2FA not enabled', async () => {
    const prismaMissing = {
      user: {
        findUnique: async () => null,
      },
    };

    const prismaDisabled = {
      user: {
        findUnique: async () => ({ twoFaEnabled: false, twoFaSecret: null }),
      },
    };

    await expect(
      verifyTwoFactorForLogin({ userId: 'u1', code: '123456' }, { env: testEnv(), prisma: prismaMissing }),
    ).rejects.toMatchObject({ statusCode: 401 });

    await expect(
      verifyTwoFactorForLogin({ userId: 'u1', code: '123456' }, { env: testEnv(), prisma: prismaDisabled }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('throws INTERNAL when DATABASE_URL is not configured', async () => {
    const prisma = {
      user: {
        findUnique: async () => null,
      },
    };

    await expect(
      verifyTwoFactorForLogin({ userId: 'u1', code: '123456' }, { env: testEnv({ DATABASE_URL: undefined }), prisma }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});
