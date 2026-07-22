import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { disableTwoFactorForUser } from '../../src/services/twofactor-disable.service.js';

describe('disableTwoFactorForUser', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://test.invalid/uoa';
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('holds the user lock through 2FA mutation, refresh revocation, and tokenVersion bump', async () => {
    const events: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => {
        events.push('user-lock');
        return [{ lockResult: '' }];
      }),
      refreshToken: {
        updateMany: vi.fn(async () => {
          events.push('refresh-revoke');
          return { count: 2 };
        }),
      },
      user: {
        findUnique: vi.fn(async () => ({ tokenVersion: 0, twoFaEnabled: true })),
        updateMany: vi.fn(async () => {
          events.push('twofa-disable');
          return { count: 1 };
        }),
        update: vi.fn(async () => {
          events.push('token-version');
          return { id: 'user-1' };
        }),
      },
      clientDomain: { findUnique: vi.fn(async () => null) },
      organisation: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const prisma = {
      $transaction: vi.fn(async (body: (client: PrismaClient) => Promise<void>) => {
        events.push('begin');
        await body(tx);
        events.push('commit');
      }),
    } as unknown as PrismaClient;

    await disableTwoFactorForUser(
      {
        userId: 'user-1',
        code: '123456',
        credentialEpoch: 0,
        config: { domain: 'client.example.com', '2fa_enabled': true },
        orgId: 'cross-product-org',
      },
      {
        prisma,
        verifyTwoFactorForLogin: async () => {
          events.push('totp-verify');
        },
      },
    );

    expect(events).toEqual([
      'begin',
      'user-lock',
      'user-lock',
      'user-lock',
      'totp-verify',
      'twofa-disable',
      'user-lock',
      'refresh-revoke',
      'token-version',
      'commit',
    ]);
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.organisation.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            domain: 'client.example.com',
            members: { some: { userId: 'user-1', status: 'ACTIVE' } },
          },
          { id: 'cross-product-org' },
        ],
      },
      select: { twoFaPolicy: true },
    });
  });
});
