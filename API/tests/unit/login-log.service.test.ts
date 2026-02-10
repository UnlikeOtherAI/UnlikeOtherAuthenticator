import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/config/env.js';
import { listLoginLogsForDomain, recordLoginLog } from '../../src/services/login-log.service.js';

type PrismaStub = {
  loginLog: {
    create: (args: unknown) => Promise<{ id: string }>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
    findMany: (args: unknown) => Promise<unknown[]>;
  };
  user: {
    findUnique: (args: unknown) => Promise<{ email: string } | null>;
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

describe('login-log.service', () => {
  it('records a login log and enforces retention', async () => {
    const now = new Date('2026-02-10T00:00:00.000Z');

    const prisma: PrismaStub = {
      loginLog: {
        create: async (args) => {
          expect(args).toMatchObject({
            data: {
              userId: 'u1',
              email: 'user@example.com',
              domain: 'client.example.com',
              authMethod: 'email_password',
              ip: '203.0.113.10',
              userAgent: 'TestUA/1.0',
              createdAt: now,
            },
          });
          return { id: 'log1' };
        },
        deleteMany: async (args) => {
          // 90 days before now.
          const cutoff = new Date('2025-11-12T00:00:00.000Z');
          expect(args).toMatchObject({ where: { createdAt: { lt: cutoff } } });
          return { count: 0 };
        },
        findMany: async () => [],
      },
      user: {
        findUnique: async () => ({ email: 'ignored@example.com' }),
      },
    };

    await recordLoginLog(
      {
        userId: 'u1',
        email: 'User@Example.com',
        domain: 'client.example.com',
        authMethod: 'email_password',
        ip: '203.0.113.10',
        userAgent: 'TestUA/1.0',
      },
      { env: testEnv({ LOG_RETENTION_DAYS: 90 }), prisma, now: () => now },
    );
  });

  it('looks up email by userId when not provided', async () => {
    const now = new Date('2026-02-10T00:00:00.000Z');

    const prisma: PrismaStub = {
      loginLog: {
        create: async (args) => {
          expect(args).toMatchObject({
            data: {
              userId: 'u1',
              email: 'lookup@example.com',
            },
          });
          return { id: 'log1' };
        },
        deleteMany: async () => ({ count: 0 }),
        findMany: async () => [],
      },
      user: {
        findUnique: async (args) => {
          expect(args).toMatchObject({ where: { id: 'u1' }, select: { email: true } });
          return { email: 'Lookup@Example.com' };
        },
      },
    };

    await recordLoginLog(
      {
        userId: 'u1',
        domain: 'client.example.com',
        authMethod: 'google',
      },
      { env: testEnv(), prisma, now: () => now },
    );
  });

  it('lists logs for a domain within retention window', async () => {
    const now = new Date('2026-02-10T00:00:00.000Z');

    const prisma: PrismaStub = {
      loginLog: {
        create: async () => ({ id: 'log1' }),
        deleteMany: async () => ({ count: 0 }),
        findMany: async (args) => {
          const cutoff = new Date('2025-11-12T00:00:00.000Z');
          expect(args).toMatchObject({
            where: { domain: 'client.example.com', createdAt: { gte: cutoff } },
            orderBy: { createdAt: 'desc' },
            take: 100,
          });
          return [
            {
              id: 'log1',
              userId: 'u1',
              email: 'user@example.com',
              domain: 'client.example.com',
              authMethod: 'email_password',
              ip: null,
              userAgent: null,
              createdAt: now,
            },
          ];
        },
      },
      user: {
        findUnique: async () => null,
      },
    };

    const logs = await listLoginLogsForDomain(
      { domain: 'client.example.com' },
      { env: testEnv({ LOG_RETENTION_DAYS: 90 }), prisma, now: () => now },
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      id: 'log1',
      userId: 'u1',
      domain: 'client.example.com',
      authMethod: 'email_password',
    });
  });
});

