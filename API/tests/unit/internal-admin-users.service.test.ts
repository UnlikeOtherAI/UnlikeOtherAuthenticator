import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  user: { findMany: vi.fn(), findUnique: vi.fn() },
  domainRole: { findMany: vi.fn() },
  loginLog: { findMany: vi.fn(), findFirst: vi.fn() },
  userAvatar: { findMany: vi.fn(), findUnique: vi.fn() },
}));

vi.mock('../../src/db/prisma.js', () => ({
  getAdminPrisma: () => prisma,
  getPrisma: () => prisma,
}));

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

// Docs/Auth/avatars.md §5 (`avatarSource`) and §9 (`avatarImageUrl`): the admin user summaries
// carry both, and the URL uses the admin-bearer form because that is the credential the caller
// used for `/internal/admin/*`.
describe('internal admin user summaries', () => {
  const original = {
    SHARED_SECRET: process.env.SHARED_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  };

  beforeEach(() => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.PUBLIC_BASE_URL = 'https://auth.example.com';
    vi.clearAllMocks();
    prisma.domainRole.findMany.mockResolvedValue([]);
    prisma.loginLog.findMany.mockResolvedValue([]);
    prisma.loginLog.findFirst.mockResolvedValue(null);
    prisma.userAvatar.findMany.mockResolvedValue([]);
    prisma.userAvatar.findUnique.mockResolvedValue(null);
  });

  afterEach(() => {
    restoreEnv('SHARED_SECRET', original.SHARED_SECRET);
    restoreEnv('DATABASE_URL', original.DATABASE_URL);
    restoreEnv('PUBLIC_BASE_URL', original.PUBLIC_BASE_URL);
  });

  it('returns an absolute admin avatar URL and the resolved source per user', async () => {
    prisma.user.findMany.mockResolvedValue([
      { lifecycleStatus: 'ACTIVE',
        id: 'user_1',
        name: 'Uploader',
        email: 'uploader@example.com',
        twoFaEnabled: false,
        avatarUrl: null,
        createdAt: new Date('2026-04-23T10:00:00Z'),
      },
      { lifecycleStatus: 'ACTIVE',
        id: 'user_2',
        name: null,
        email: 'provider@example.com',
        twoFaEnabled: true,
        avatarUrl: 'https://cdn.example.com/a.png',
        createdAt: new Date('2026-04-23T11:00:00Z'),
      },
    ]);
    prisma.userAvatar.findMany.mockResolvedValue([{ userId: 'user_1' }]);

    const { getAdminUsers } = await import('../../src/services/internal-admin.service.users.js');
    const users = await getAdminUsers();

    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({
      id: 'user_1',
      avatarSource: 'uploaded',
      avatarImageUrl: 'https://auth.example.com/internal/admin/users/user_1/avatar',
    });
    expect(users[1]).toMatchObject({
      id: 'user_2',
      avatarSource: 'provider',
      avatarImageUrl: 'https://auth.example.com/internal/admin/users/user_2/avatar',
    });
    // One batched lookup for the page, never one per user.
    expect(prisma.userAvatar.findMany).toHaveBeenCalledTimes(1);
  });

  it('returns the same pair on the single-user read, generated when nothing is set', async () => {
    prisma.user.findUnique.mockResolvedValue({ lifecycleStatus: 'ACTIVE',
      id: 'user_3',
      name: 'Generated',
      email: 'generated@example.com',
      twoFaEnabled: false,
      avatarUrl: null,
      createdAt: new Date('2026-04-23T12:00:00Z'),
    });

    const { getAdminUser } = await import('../../src/services/internal-admin.service.users.js');

    await expect(getAdminUser('user_3')).resolves.toMatchObject({
      id: 'user_3',
      avatarSource: 'generated',
      avatarImageUrl: 'https://auth.example.com/internal/admin/users/user_3/avatar',
    });
  });

  it('emits a root-relative URL when PUBLIC_BASE_URL is unset', async () => {
    Reflect.deleteProperty(process.env, 'PUBLIC_BASE_URL');
    prisma.user.findUnique.mockResolvedValue({ lifecycleStatus: 'ACTIVE',
      id: 'user_4',
      name: null,
      email: 'relative@example.com',
      twoFaEnabled: false,
      avatarUrl: null,
      createdAt: new Date('2026-04-23T13:00:00Z'),
    });

    const { getAdminUser } = await import('../../src/services/internal-admin.service.users.js');

    await expect(getAdminUser('user_4')).resolves.toMatchObject({
      avatarImageUrl: '/internal/admin/users/user_4/avatar',
    });
  });
});
