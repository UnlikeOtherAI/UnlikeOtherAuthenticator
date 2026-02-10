import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { createClientId } from '../../src/utils/hash.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)('GET /domain/logs', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.SHARED_SECRET = originalSharedSecret;
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    if (!handle) return;
    await handle.prisma.loginLog.deleteMany();
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.verificationToken.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  it('returns recent logs for a domain when authorized', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';

    const user = await handle!.prisma.user.create({
      data: {
        email: 'user@example.com',
        userKey: 'user@example.com',
        passwordHash: null,
      },
      select: { id: true },
    });

    await handle!.prisma.loginLog.createMany({
      data: [
        {
          userId: user.id,
          email: 'user@example.com',
          domain: 'client.example.com',
          authMethod: 'google',
          ip: '203.0.113.1',
          userAgent: 'UA-1',
          createdAt: new Date('2026-02-10T00:00:00.000Z'),
        },
        {
          userId: user.id,
          email: 'user@example.com',
          domain: 'client.example.com',
          authMethod: 'email_password',
          ip: '203.0.113.2',
          userAgent: 'UA-2',
          createdAt: new Date('2026-02-10T01:00:00.000Z'),
        },
      ],
    });

    const token = createClientId('client.example.com', process.env.SHARED_SECRET);

    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/domain/logs?domain=client.example.com',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      logs: Array<{
        id: string;
        user_id: string;
        email: string;
        domain: string;
        timestamp: string;
        auth_method: string;
        ip: string | null;
        user_agent: string | null;
      }>;
    };

    expect(body.ok).toBe(true);
    expect(body.logs).toHaveLength(2);
    // Most recent first.
    expect(body.logs[0].auth_method).toBe('email_password');
    expect(body.logs[0].ip).toBe('203.0.113.2');
    expect(body.logs[1].auth_method).toBe('google');
    expect(body.logs[1].ip).toBe('203.0.113.1');

    await app.close();
  });

  it('returns 401 when the domain hash token is invalid', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';

    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/domain/logs?domain=client.example.com',
      headers: {
        authorization: `Bearer invalid`,
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });
});

