import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureDomainRoleForUser } from '../../src/services/domain-role.service.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)('ensureDomainRoleForUser (DB-backed)', () => {
  const domain = 'client.example.com';

  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
  });

  afterAll(async () => {
    if (!handle) return;
    await handle.cleanup();
  });

  beforeEach(async () => {
    if (!handle) return;
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  it('assigns SUPERUSER to the first user on a domain, then USER to the second', async () => {
    if (!handle) throw new Error('missing db');

    const u1 = await handle.prisma.user.create({
      data: { email: 'u1@example.com', userKey: 'u1@example.com' },
    });
    const u2 = await handle.prisma.user.create({
      data: { email: 'u2@example.com', userKey: 'u2@example.com' },
    });

    const r1 = await ensureDomainRoleForUser({
      prisma: handle.prisma,
      domain,
      userId: u1.id,
    });
    const r2 = await ensureDomainRoleForUser({
      prisma: handle.prisma,
      domain,
      userId: u2.id,
    });

    expect(r1.role).toBe('SUPERUSER');
    expect(r2.role).toBe('USER');
  });

  it('handles concurrent inserts deterministically: exactly one SUPERUSER per domain', async () => {
    if (!handle) throw new Error('missing db');

    const users = await Promise.all(
      Array.from({ length: 6 }).map(async (_, i) => {
        const email = `u${i}@example.com`;
        return await handle.prisma.user.create({ data: { email, userKey: email } });
      }),
    );

    const roles = await Promise.all(
      users.map(async (u) => {
        return await ensureDomainRoleForUser({
          prisma: handle.prisma,
          domain,
          userId: u.id,
        });
      }),
    );

    const superusers = roles.filter((r) => r.role === 'SUPERUSER');
    const normals = roles.filter((r) => r.role === 'USER');

    expect(superusers).toHaveLength(1);
    expect(normals).toHaveLength(users.length - 1);
  });

  it('is idempotent for the same (domain, user) pair', async () => {
    if (!handle) throw new Error('missing db');

    const user = await handle.prisma.user.create({
      data: { email: 'idem@example.com', userKey: 'idem@example.com' },
    });

    const first = await ensureDomainRoleForUser({
      prisma: handle.prisma,
      domain,
      userId: user.id,
    });
    const second = await ensureDomainRoleForUser({
      prisma: handle.prisma,
      domain,
      userId: user.id,
    });

    expect(second.role).toBe(first.role);
    expect(second.domain).toBe(first.domain);
    expect(second.userId).toBe(first.userId);

    const rows = await handle.prisma.domainRole.findMany();
    expect(rows).toHaveLength(1);
  });
});

