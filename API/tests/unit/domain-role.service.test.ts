import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDomainRoleForUser } from '../../src/services/domain-role.service.js';
import { createTestDb } from '../helpers/test-db.js';
import type { PrismaClient } from '@prisma/client';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe('ensureDomainRoleForUser (unit)', () => {
  it('assigns SUPERUSER when no SUPERUSER exists for the domain', async () => {
    const domainInput = 'Client.Example.com.';
    const domain = 'client.example.com';
    const userId = 'u_1';
    const createdAt = new Date('2026-02-10T00:00:00.000Z');

    const prisma = {
      domainRole: {
        findUnique: vi.fn().mockResolvedValueOnce(null),
        findFirst: vi.fn().mockResolvedValueOnce(null),
        create: vi.fn().mockResolvedValueOnce({ domain, userId, role: 'SUPERUSER', createdAt }),
      },
    } as unknown as PrismaClient;

    const result = await ensureDomainRoleForUser({ prisma, domain: domainInput, userId });

    expect(result.role).toBe('SUPERUSER');
    expect(prisma.domainRole.findFirst).toHaveBeenCalledWith({
      where: { domain, role: 'SUPERUSER' },
      select: { userId: true },
    });
    expect(prisma.domainRole.create).toHaveBeenCalledTimes(1);
    expect(prisma.domainRole.create.mock.calls[0][0].data).toEqual({ domain, userId, role: 'SUPERUSER' });
  });

  it('assigns USER when a SUPERUSER already exists for the domain', async () => {
    const domain = 'client.example.com';
    const userId = 'u_2';
    const createdAt = new Date('2026-02-10T00:00:00.000Z');

    const prisma = {
      domainRole: {
        findUnique: vi.fn().mockResolvedValueOnce(null),
        findFirst: vi.fn().mockResolvedValueOnce({ userId: 'u_other' }),
        create: vi.fn().mockResolvedValueOnce({ domain, userId, role: 'USER', createdAt }),
      },
    } as unknown as PrismaClient;

    const result = await ensureDomainRoleForUser({ prisma, domain, userId });

    expect(result.role).toBe('USER');
    expect(prisma.domainRole.create).toHaveBeenCalledTimes(1);
    expect(prisma.domainRole.create.mock.calls[0][0].data).toEqual({ domain, userId, role: 'USER' });
  });

  it('returns early when a row for (domain, user) already exists', async () => {
    const domain = 'client.example.com';
    const userId = 'u_3';
    const existing = {
      domain,
      userId,
      role: 'USER',
      createdAt: new Date('2026-02-10T00:00:00.000Z'),
    };

    const prisma = {
      domainRole: {
        findUnique: vi.fn().mockResolvedValueOnce(existing),
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    } as unknown as PrismaClient;

    const result = await ensureDomainRoleForUser({ prisma, domain, userId });

    expect(result).toBe(existing);
    expect(prisma.domainRole.findFirst).not.toHaveBeenCalled();
    expect(prisma.domainRole.create).not.toHaveBeenCalled();
  });
});

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

  it('never creates more than one SUPERUSER per domain under parallel load', async () => {
    if (!handle) throw new Error('missing db');

    const users = await Promise.all(
      Array.from({ length: 6 }).map(async (_, i) => {
        const email = `u${i}@example.com`;
        return await handle.prisma.user.create({ data: { email, userKey: email } });
      }),
    );

    // A brand-new domain with no prior SUPERUSER row is the worst case for
    // concurrency: every parallel caller reads null from the pre-check and
    // races on the INSERT. The partial unique index guarantees at most one
    // SUPERUSER survives. Some parallel calls may reject with P2002 and be
    // retried by the caller on the next login attempt; we only assert the
    // DB-level invariant.
    await Promise.allSettled(
      users.map(async (u) => {
        return await ensureDomainRoleForUser({
          prisma: handle.prisma,
          domain,
          userId: u.id,
        });
      }),
    );

    const superusers = await handle.prisma.domainRole.findMany({
      where: { domain, role: 'SUPERUSER' },
    });
    expect(superusers.length).toBeLessThanOrEqual(1);
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
