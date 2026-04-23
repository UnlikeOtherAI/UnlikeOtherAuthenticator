import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const domainRole = vi.hoisted(() => ({
  count: vi.fn(),
  delete: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
}));

const user = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
}));

const prisma = vi.hoisted(() => ({
  domainRole,
  user,
  $transaction: vi.fn(async (fn: (tx: { domainRole: typeof domainRole }) => unknown) =>
    fn({ domainRole }),
  ),
}));

vi.mock('../../src/db/prisma.js', () => ({
  getAdminPrisma: () => prisma,
}));

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

describe('admin superuser service', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAdminDomain = process.env.ADMIN_AUTH_DOMAIN;

  beforeEach(() => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.ADMIN_AUTH_DOMAIN = 'Admin.Example.Com.';
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreEnv('SHARED_SECRET', originalSharedSecret);
    restoreEnv('ADMIN_AUTH_DOMAIN', originalAdminDomain);
  });

  it('lists admin-domain superusers', async () => {
    domainRole.findMany.mockResolvedValue([
      {
        userId: 'user_1',
        createdAt: new Date('2026-04-23T10:00:00Z'),
        user: { email: 'admin@example.com', name: 'Admin' },
      },
    ]);
    const { listAdminSuperusers } = await import('../../src/services/admin-superusers.service.js');

    await expect(listAdminSuperusers()).resolves.toEqual([
      {
        userId: 'user_1',
        email: 'admin@example.com',
        name: 'Admin',
        createdAt: '2026-04-23T10:00:00.000Z',
      },
    ]);
    expect(domainRole.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { domain: 'admin.example.com', role: 'SUPERUSER' } }),
    );
  });

  it('searches users who are not already admin-domain superusers', async () => {
    user.findMany.mockResolvedValue([{ id: 'user_2', email: 'user@example.com', name: null }]);
    const { searchNonSuperusers } = await import('../../src/services/admin-superusers.service.js');

    await expect(searchNonSuperusers('user')).resolves.toEqual([
      { userId: 'user_2', email: 'user@example.com', name: null },
    ]);
    expect(user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          domainRoles: { none: { domain: 'admin.example.com', role: 'SUPERUSER' } },
        }),
        take: 20,
      }),
    );
  });

  it('grants superuser idempotently with upsert', async () => {
    user.findUnique.mockResolvedValue({ id: 'user_3', email: 'grant@example.com', name: 'Grant' });
    domainRole.upsert.mockResolvedValue({
      userId: 'user_3',
      createdAt: new Date('2026-04-23T11:00:00Z'),
      user: { email: 'grant@example.com', name: 'Grant' },
    });
    const { grantAdminSuperuser } = await import('../../src/services/admin-superusers.service.js');

    await expect(grantAdminSuperuser('user_3')).resolves.toMatchObject({
      userId: 'user_3',
      email: 'grant@example.com',
    });
    expect(domainRole.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { domain_userId: { domain: 'admin.example.com', userId: 'user_3' } },
        update: { role: 'SUPERUSER' },
      }),
    );
  });

  it('refuses to revoke the caller', async () => {
    const { revokeAdminSuperuser } = await import('../../src/services/admin-superusers.service.js');

    await expect(
      revokeAdminSuperuser({ userId: 'user_1', actorUserId: 'user_1' }),
    ).rejects.toMatchObject({ statusCode: 409, message: 'CANNOT_REMOVE_SELF' });
  });

  it('refuses to revoke the last superuser', async () => {
    domainRole.count.mockResolvedValue(1);
    const { revokeAdminSuperuser } = await import('../../src/services/admin-superusers.service.js');

    await expect(
      revokeAdminSuperuser({ userId: 'user_2', actorUserId: 'user_1' }),
    ).rejects.toMatchObject({ statusCode: 409, message: 'CANNOT_REMOVE_LAST_SUPERUSER' });
    expect(domainRole.delete).not.toHaveBeenCalled();
  });
});
