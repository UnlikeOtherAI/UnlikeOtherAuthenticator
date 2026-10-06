import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerDomainUsersRoute } from '../../src/routes/domain/users.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { createRlsTestDb } from '../helpers/test-db.js';

const clients = vi.hoisted(() => ({
  app: null as PrismaClient | null,
  admin: null as PrismaClient | null,
}));
vi.mock('../../src/db/prisma.js', () => ({
  getPrisma: () => clients.app!,
  getAdminPrisma: () => clients.admin!,
}));

const DOMAIN = 'ledger.example.com';
const OTHER_DOMAIN = 'other.example.com';

// Exercise the endpoint's default client selection with the actual production
// roles. A superuser-backed or injected-client test misses the empty result
// returned by uoa_app on this pre-tenant-context route.
describe.skipIf(!process.env.DATABASE_URL)('domain profiles with production RLS roles', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createRlsTestDb>>>;
  let app: FastifyInstance;
  let bearer: string;
  let otherBearer: string;
  let personId: string;
  let otherId: string;
  let disabledId: string;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    handle = (await createRlsTestDb())!;
    clients.app = new PrismaClient({ datasources: { db: { url: handle.appDatabaseUrl } } });
    clients.admin = new PrismaClient({ datasources: { db: { url: handle.adminDatabaseUrl } } });
    process.env.DATABASE_URL = handle.appDatabaseUrl;

    const person = await handle.prisma.user.create({
      data: {
        email: 'operator@example.com',
        userKey: 'operator@example.com',
        name: 'Operator',
        domain: DOMAIN,
      },
    });
    const other = await handle.prisma.user.create({
      data: { email: 'other@example.com', userKey: 'other@example.com', domain: OTHER_DOMAIN },
    });
    const disabled = await handle.prisma.user.create({
      data: { email: 'disabled@example.com', userKey: 'disabled@example.com' },
    });
    personId = person.id;
    otherId = other.id;
    disabledId = disabled.id;
    await handle.prisma.domainRole.createMany({
      data: [
        { domain: DOMAIN, userId: personId, role: 'SUPERUSER' },
        { domain: OTHER_DOMAIN, userId: otherId, role: 'USER' },
        { domain: DOMAIN, userId: disabledId, role: 'USER' },
      ],
    });
    await handle.prisma.user.update({
      where: { id: disabledId },
      data: { lifecycleStatus: 'DISABLED' },
    });
    await handle.prisma.userAvatar.create({
      data: { userId: personId, contentType: 'image/png', sizeBytes: 1, data: Buffer.from([1]) },
    });
    bearer = await seedDomainSecret(handle.prisma, DOMAIN);
    otherBearer = await seedDomainSecret(handle.prisma, OTHER_DOMAIN);
    app = Fastify({ logger: false });
    registerDomainUsersRoute(app);
    await app.ready();
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    await app?.close();
    await clients.app?.$disconnect();
    await clients.admin?.$disconnect();
    await handle?.cleanup();
  });

  async function lookup(domain = DOMAIN, userId?: string, token = bearer) {
    const query = new URLSearchParams({ domain });
    if (userId) query.set('user_id', userId);
    return app.inject({
      method: 'GET',
      url: `/domain/users?${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('resolves the exact signed-in subject and uploaded avatar metadata', async () => {
    const res = await lookup(DOMAIN, personId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      users: [
        {
          id: personId,
          email: 'operator@example.com',
          name: 'Operator',
          avatar_source: 'uploaded',
          role: 'superuser',
        },
      ],
    });
    expect(res.json().users).toHaveLength(1);
    expect(res.json().users[0]).not.toHaveProperty('password_hash');
    expect(res.json().users[0]).not.toHaveProperty('user_key');
  });

  it('lists only active users on the authenticated domain', async () => {
    const res = await lookup();
    expect(res.statusCode).toBe(200);
    expect(res.json().users.map((user: { id: string }) => user.id)).toEqual([personId]);
  });

  it('does not disclose another domain subject or a disabled subject', async () => {
    for (const userId of [otherId, disabledId, 'unknown']) {
      const res = await lookup(DOMAIN, userId);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, users: [] });
    }
  });

  it('requires the bearer for the exact requested domain', async () => {
    expect((await lookup(OTHER_DOMAIN, otherId)).statusCode).toBe(401);
    expect((await lookup(DOMAIN, personId, 'invalid')).statusCode).toBe(401);
    const res = await lookup(OTHER_DOMAIN, otherId, otherBearer);
    expect(res.statusCode).toBe(200);
    expect(res.json().users.map((user: { id: string }) => user.id)).toEqual([otherId]);
  });

  it('reproduces the invisible domain roles on the unscoped runtime client', async () => {
    expect(await clients.app!.domainRole.findMany({ where: { domain: DOMAIN } })).toEqual([]);
    expect(await clients.admin!.domainRole.count({ where: { domain: DOMAIN } })).toBe(2);
  });
});
