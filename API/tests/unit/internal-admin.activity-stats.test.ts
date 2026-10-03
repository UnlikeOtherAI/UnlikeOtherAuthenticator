import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ databaseEnabled: true }));
const prisma = vi.hoisted(() => ({
  user: { count: vi.fn() },
  organisation: { count: vi.fn() },
  clientDomain: { count: vi.fn() },
  loginLog: { findMany: vi.fn(), count: vi.fn() },
}));

vi.mock('../../src/config/env.js', () => ({
  getEnv: () => ({
    DATABASE_URL: state.databaseEnabled ? 'postgresql://test.invalid/db' : undefined,
  }),
}));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => prisma }));
vi.mock('../../src/services/twofactor-disable.service.js', () => ({
  resetTwoFactorForUser: vi.fn(),
}));
vi.mock('../../src/services/audit-log.service.js', () => ({ writeAuditLog: vi.fn() }));

import { getAdminStats } from '../../src/services/internal-admin.service.base.js';
import { getAdminLogs } from '../../src/services/internal-admin.service.users.js';

beforeEach(() => {
  state.databaseEnabled = true;
  vi.resetAllMocks();
  prisma.loginLog.findMany.mockResolvedValue([]);
});

afterEach(() => vi.useRealTimers());

describe('admin login activity', () => {
  it('filters by exact stable user ID in the database before applying the recent-event limit', async () => {
    const createdAt = new Date('2026-10-03T09:30:17.123+02:00');
    prisma.loginLog.findMany.mockResolvedValue([
      {
        id: 'event-1',
        userId: 'subject-1',
        email: 'previous-address@example.com',
        domain: 'example.com/product',
        authMethod: 'GOOGLE',
        ip: '192.0.2.1',
        userAgent: 'Synthetic browser',
        createdAt,
      },
    ]);

    const logs = await getAdminLogs(25, 'subject-1');

    expect(prisma.loginLog.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: 'subject-1' },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: {
        id: true,
        userId: true,
        email: true,
        domain: true,
        authMethod: true,
        ip: true,
        userAgent: true,
        createdAt: true,
      },
    });
    expect(logs).toEqual([
      {
        id: 'event-1',
        userId: 'subject-1',
        occurredAt: '2026-10-03T07:30:17.123Z',
        ts: '2026-10-03 07:30:17',
        user: 'previous-address@example.com',
        domain: 'example.com/product',
        method: 'google',
        ip: '192.0.2.1',
        userAgent: 'Synthetic browser',
        result: 'ok',
      },
    ]);
    expect(logs[0].occurredAt).toBe(createdAt.toISOString());
  });

  it('keeps global activity unfiltered and defaults to 100 recent events', async () => {
    await getAdminLogs();
    expect(prisma.loginLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: undefined,
        take: 100,
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it.each([
    [0, 1],
    [-10, 1],
    [1, 1],
    [500, 500],
    [501, 500],
    [10_000, 500],
  ])(
    'bounds a requested limit of %i to %i without widening the user filter',
    async (requested, expected) => {
      await getAdminLogs(requested, 'subject-2');
      expect(prisma.loginLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'subject-2' },
          take: expected,
        }),
      );
    },
  );

  it('preserves anonymous audit events without inventing a user or dropping their timestamp', async () => {
    prisma.loginLog.findMany.mockResolvedValue([
      {
        id: 'anonymous',
        userId: null,
        email: '',
        domain: 'example.com',
        authMethod: 'EMAIL',
        ip: null,
        userAgent: null,
        createdAt: new Date('2026-10-03T00:00:00Z'),
      },
    ]);
    await expect(getAdminLogs()).resolves.toEqual([
      expect.objectContaining({
        userId: null,
        user: null,
        occurredAt: '2026-10-03T00:00:00.000Z',
        method: 'email',
      }),
    ]);
  });

  it('does not access the database when it is disabled', async () => {
    state.databaseEnabled = false;
    await expect(getAdminLogs(10, 'subject-1')).resolves.toEqual([]);
    expect(prisma.loginLog.findMany).not.toHaveBeenCalled();
  });
});

describe('admin dashboard counts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    prisma.user.count.mockResolvedValue(17);
    prisma.organisation.count.mockResolvedValue(4);
    prisma.clientDomain.count.mockResolvedValue(2);
    prisma.loginLog.count.mockResolvedValue(6);
  });

  it('counts active registered services rather than domains observed in roles, organisations or logs', async () => {
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    await expect(getAdminStats()).resolves.toEqual({
      users: 17,
      orgs: 4,
      domains: 2,
      loginsToday: 6,
    });
    expect(prisma.clientDomain.count).toHaveBeenCalledExactlyOnceWith({
      where: { status: 'ACTIVE' },
    });
    expect(prisma.user.count).toHaveBeenCalledExactlyOnceWith();
    expect(prisma.organisation.count).toHaveBeenCalledExactlyOnceWith();
    expect(prisma.loginLog.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['2026-10-02T23:59:59.999Z', '2026-10-02T00:00:00.000Z'],
    ['2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z'],
    ['2026-10-03T00:30:00.000Z', '2026-10-03T00:00:00.000Z'],
    ['2026-10-03T23:59:59.999Z', '2026-10-03T00:00:00.000Z'],
  ])('starts the login count at UTC midnight when now is %s', async (now, midnight) => {
    // A non-UTC process catches an accidental regression to Date.setHours().
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'Pacific/Honolulu';
    try {
      vi.setSystemTime(new Date(now));
      expect(new Date().getTimezoneOffset()).toBe(600);
      await getAdminStats();
      expect(prisma.loginLog.count).toHaveBeenCalledExactlyOnceWith({
        where: { createdAt: { gte: new Date(midnight) } },
      });
    } finally {
      if (previousTimezone === undefined) Reflect.deleteProperty(process.env, 'TZ');
      else process.env.TZ = previousTimezone;
    }
  });

  it('returns zero counts without querying when the database is disabled', async () => {
    state.databaseEnabled = false;
    await expect(getAdminStats()).resolves.toEqual({
      users: 0,
      orgs: 0,
      domains: 0,
      loginsToday: 0,
    });
    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(prisma.organisation.count).not.toHaveBeenCalled();
    expect(prisma.clientDomain.count).not.toHaveBeenCalled();
    expect(prisma.loginLog.count).not.toHaveBeenCalled();
  });
});
