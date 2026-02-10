import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/config/env.js';
import { enrollTwoFactorForUser } from '../../src/services/twofactor-enroll.service.js';
import { decryptTwoFaSecret } from '../../src/utils/twofa-secret.js';

type PrismaUpdateManyArgs = {
  where: { id: string; twoFaEnabled: boolean };
  data: { twoFaEnabled: boolean; twoFaSecret: string };
};

type PrismaFindUniqueArgs = {
  where: { id: string };
  select: { id: true; twoFaEnabled: true };
};

type PrismaStub = {
  user: {
    updateMany: (args: PrismaUpdateManyArgs) => Promise<{ count: number }>;
    findUnique: (args: PrismaFindUniqueArgs) => Promise<{ id: string; twoFaEnabled: boolean } | null>;
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

describe('enrollTwoFactorForUser', () => {
  it('marks 2FA enabled and stores encrypted secret after code verification', async () => {
    let storedSecret: string | null = null;

    const prisma: PrismaStub = {
      user: {
        updateMany: async (args) => {
          expect(args.where).toEqual({ id: 'u1', twoFaEnabled: false });
          expect(args.data.twoFaEnabled).toBe(true);
          expect(args.data.twoFaSecret).toContain('v1:');
          storedSecret = args.data.twoFaSecret;
          return { count: 1 };
        },
        findUnique: async () => {
          throw new Error('should not be called');
        },
      },
    };

    await enrollTwoFactorForUser(
      { userId: 'u1', totpSecret: 'JBSWY3DPEHPK3PXP', code: '123456' },
      {
        env: testEnv(),
        prisma,
        sharedSecret: 'test-shared-secret',
        verifyTotpCode: () => true,
      },
    );

    expect(storedSecret).not.toBeNull();
    const decrypted = decryptTwoFaSecret({
      encryptedSecret: storedSecret!,
      sharedSecret: 'test-shared-secret',
    });
    expect(decrypted).toBe('JBSWY3DPEHPK3PXP');
  });

  it('throws UNAUTHORIZED when the TOTP code does not verify', async () => {
    const prisma: PrismaStub = {
      user: {
        updateMany: async () => ({ count: 0 }),
        findUnique: async () => null,
      },
    };

    await expect(
      enrollTwoFactorForUser(
        { userId: 'u1', totpSecret: 'JBSWY3DPEHPK3PXP', code: '000000' },
        {
          env: testEnv(),
          prisma,
          verifyTotpCode: () => false,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('throws BAD_REQUEST when the user already has 2FA enabled', async () => {
    const prisma: PrismaStub = {
      user: {
        updateMany: async () => ({ count: 0 }),
        findUnique: async (args) => {
          expect(args.where.id).toBe('u1');
          return { id: 'u1', twoFaEnabled: true };
        },
      },
    };

    await expect(
      enrollTwoFactorForUser(
        { userId: 'u1', totpSecret: 'JBSWY3DPEHPK3PXP', code: '123456' },
        {
          env: testEnv(),
          prisma,
          verifyTotpCode: () => true,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws INTERNAL when DATABASE_URL is not configured', async () => {
    const prisma: PrismaStub = {
      user: {
        updateMany: async () => ({ count: 0 }),
        findUnique: async () => null,
      },
    };

    await expect(
      enrollTwoFactorForUser(
        { userId: 'u1', totpSecret: 'JBSWY3DPEHPK3PXP', code: '123456' },
        {
          env: testEnv({ DATABASE_URL: undefined }),
          prisma,
          verifyTotpCode: () => true,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});

