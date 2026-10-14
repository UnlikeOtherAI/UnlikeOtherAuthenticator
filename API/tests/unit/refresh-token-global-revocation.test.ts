import type { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { revokeAllRefreshTokensForUser } from '../../src/services/refresh-token-revocation.service.js';
import { revokeRefreshTokenFamily } from '../../src/services/refresh-token.service.js';

describe('global refresh revocation', () => {
  it('commits lock, all-token revocation, and tokenVersion in one transaction', async () => {
    const events: string[] = [];
    const tx = {
      orgMember: { findMany: vi.fn().mockResolvedValue([{ orgId: 'org-1' }]) },
      organisation: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn(async (query: Prisma.Sql) => {
        events.push(query.sql.includes('uoa_record_directory_change') ? 'directory-event' : 'lock');
        return [{ lockResult: '' }];
      }),
      refreshToken: {
        updateMany: vi.fn(async () => {
          events.push('refresh-revoke');
          return { count: 3 };
        }),
      },
      user: {
        update: vi.fn(async () => {
          events.push('token-version');
          return { id: 'user-1' };
        }),
      },
    } as unknown as PrismaClient;
    const prisma = {
      $transaction: vi.fn(async (body: (client: PrismaClient) => Promise<void>) => {
        events.push('begin');
        await body(tx);
        events.push('commit');
      }),
    } as unknown as PrismaClient;

    await revokeAllRefreshTokensForUser('user-1', { prisma });

    expect(events[0]).toBe('begin');
    expect(events.at(-1)).toBe('commit');
    expect(events.indexOf('lock')).toBeLessThan(events.indexOf('refresh-revoke'));
    expect(events.indexOf('refresh-revoke')).toBeLessThan(events.indexOf('token-version'));
    expect(events.indexOf('token-version')).toBeLessThan(events.indexOf('directory-event'));
    const eventQuery = vi.mocked(tx.$queryRaw).mock.calls
      .map(([query]) => query as Prisma.Sql)
      .find((query) => query.sql.includes('uoa_record_directory_change'));
    expect(eventQuery?.values.slice(1)).toEqual([
      'org-1', 'credential_epoch.changed', 'user-1', null,
    ]);
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { tokenVersion: { increment: 1 } },
    });
  });

  it('preserves logout no-oracle behavior without locking on an unknown token', async () => {
    const prisma = {
      $queryRaw: vi.fn(),
      refreshToken: {
        findUnique: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn(),
      },
      user: { update: vi.fn() },
    } as unknown as PrismaClient;

    await expect(
      revokeRefreshTokenFamily(
        {
          refreshToken: 'unknown',
          clientId: 'client-id',
          configUrl: 'https://client.example/auth-config',
          domain: 'client.example',
        },
        { prisma, sharedSecret: 'test-shared-secret-with-enough-length' },
      ),
    ).resolves.toBeUndefined();

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
