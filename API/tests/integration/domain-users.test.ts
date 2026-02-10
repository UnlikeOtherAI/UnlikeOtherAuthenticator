import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { createClientId } from '../../src/utils/hash.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)('GET /domain/users', () => {
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

  it('returns users for a domain when authorized', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';

    const now = Date.now();
    const older = new Date(now - 60_000);
    const newer = new Date(now - 30_000);

    const user1 = await handle!.prisma.user.create({
      data: {
        email: 'older@example.com',
        userKey: 'older@example.com',
        passwordHash: null,
        name: 'Older',
        twoFaEnabled: true,
        avatarUrl: 'https://example.com/a.png',
        createdAt: older,
      },
      select: { id: true },
    });

    const user2 = await handle!.prisma.user.create({
      data: {
        email: 'newer@example.com',
        userKey: 'newer@example.com',
        passwordHash: null,
        name: null,
        twoFaEnabled: false,
        avatarUrl: null,
        createdAt: newer,
      },
      select: { id: true },
    });

    await handle!.prisma.domainRole.createMany({
      data: [
        { domain: 'client.example.com', userId: user1.id, role: 'USER', createdAt: older },
        { domain: 'client.example.com', userId: user2.id, role: 'SUPERUSER', createdAt: newer },
      ],
    });

    const token = createClientId('client.example.com', process.env.SHARED_SECRET);

    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/domain/users?domain=client.example.com',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      users: Array<{
        id: string;
        email: string;
        name: string | null;
        avatar_url: string | null;
        twofa_enabled: boolean;
        role: 'superuser' | 'user';
        created_at: string;
      }>;
    };

    expect(body.ok).toBe(true);
    expect(body.users).toHaveLength(2);
    // Most recent role assignment first.
    expect(body.users[0].email).toBe('newer@example.com');
    expect(body.users[0].role).toBe('superuser');
    expect(body.users[1].email).toBe('older@example.com');
    expect(body.users[1].role).toBe('user');

    // Non-sensitive fields only: ensure sensitive fields are not present.
    expect(body.users[0]).not.toHaveProperty('password_hash');
    expect(body.users[0]).not.toHaveProperty('twofa_secret');
    expect(body.users[0]).not.toHaveProperty('user_key');

    await app.close();
  });

  it('returns 401 when the domain hash token is invalid', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';

    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/domain/users?domain=client.example.com',
      headers: {
        authorization: 'Bearer invalid',
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });
});

