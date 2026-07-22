import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  revokeRefreshTokensForUserDomain,
} from '../../src/services/refresh-token-revocation.service.js';

describe('refresh-token domain revocation (unit)', () => {
  it('revokes only the domain refresh tokens without bumping the user token version', async () => {
    const now = new Date('2026-03-10T13:30:00.000Z');
    const userUpdate = vi.fn();
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ lockResult: '' }]),
      refreshToken: {
        updateMany: vi.fn().mockResolvedValue({ count: 3 }),
      },
      user: {
        update: userUpdate,
      },
    } as unknown as PrismaClient;

    const result = await revokeRefreshTokensForUserDomain('user-1', 'client.example.com', {
      now: () => now,
      prisma,
    });

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        domain: 'client.example.com',
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
    expect(result).toEqual({ revokedCount: 3 });
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
