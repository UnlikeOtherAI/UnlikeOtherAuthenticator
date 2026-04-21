import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/config/env.js';
import { pruneExpiredSecurityData } from '../../src/services/retention-pruning.service.js';

function testEnv(): Env {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 3000,
    PUBLIC_BASE_URL: 'https://auth.example.com',
    LOG_LEVEL: 'info',
    SHARED_SECRET: 'test-shared-secret-with-enough-length',
    AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
    CONFIG_JWKS_URL: 'https://auth.example.com/.well-known/jwks.json',
    DATABASE_URL: 'postgres://example.invalid/db',
    ACCESS_TOKEN_TTL: '30m',
    REFRESH_TOKEN_TTL_DAYS: 30,
    TOKEN_PRUNE_RETENTION_DAYS: 7,
    LOG_RETENTION_DAYS: 90,
    AI_TRANSLATION_PROVIDER: 'disabled',
  };
}

describe('retention-pruning.service', () => {
  it('prunes expired token rows and old login logs', async () => {
    const now = new Date('2026-04-20T12:00:00.000Z');
    const calls: Record<string, unknown> = {};
    const prisma = {
      refreshToken: {
        deleteMany: async (args: unknown) => {
          calls.refreshToken = args;
          return { count: 1 };
        },
      },
      authorizationCode: {
        deleteMany: async (args: unknown) => {
          calls.authorizationCode = args;
          return { count: 2 };
        },
      },
      verificationToken: {
        deleteMany: async (args: unknown) => {
          calls.verificationToken = args;
          return { count: 3 };
        },
      },
      loginLog: {
        deleteMany: async (args: unknown) => {
          calls.loginLog = args;
          return { count: 4 };
        },
      },
      handshakeErrorLog: {
        deleteMany: async (args: unknown) => {
          calls.handshakeErrorLog = args;
          return { count: 5 };
        },
      },
    };

    const result = await pruneExpiredSecurityData({
      env: testEnv(),
      prisma,
      now: () => now,
    });

    expect(calls.refreshToken).toMatchObject({
      where: { expiresAt: { lt: new Date('2026-04-13T12:00:00.000Z') } },
    });
    expect(calls.authorizationCode).toMatchObject({
      where: { expiresAt: { lt: now } },
    });
    expect(calls.verificationToken).toMatchObject({
      where: { expiresAt: { lt: now } },
    });
    expect(calls.loginLog).toMatchObject({
      where: { createdAt: { lt: new Date('2026-01-20T12:00:00.000Z') } },
    });
    expect(calls.handshakeErrorLog).toMatchObject({
      where: { createdAt: { lt: new Date('2026-01-20T12:00:00.000Z') } },
    });
    expect(result).toEqual({
      authorizationCodesDeleted: 2,
      handshakeErrorLogsDeleted: 5,
      loginLogsDeleted: 4,
      refreshTokensDeleted: 1,
      verificationTokensDeleted: 3,
    });
  });
});
