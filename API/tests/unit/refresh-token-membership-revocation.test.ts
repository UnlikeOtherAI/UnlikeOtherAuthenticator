import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  revokeRefreshTokenFamiliesForUserOrganisation,
  revokeRefreshTokenFamiliesForUserTeam,
} from '../../src/services/refresh-token.service.js';

describe('refresh-token membership revocation', () => {
  const now = new Date('2026-07-21T12:00:00.000Z');

  function makePrisma(count: number): PrismaClient {
    return {
      refreshToken: {
        updateMany: vi.fn().mockResolvedValue({ count }),
      },
    } as unknown as PrismaClient;
  }

  it('revokes exact user-and-organisation refresh families across issuing domains', async () => {
    const prisma = makePrisma(4);

    const result = await revokeRefreshTokenFamiliesForUserOrganisation('user-1', 'org-1', {
      now: () => now,
      prisma,
    });

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', orgId: 'org-1', revokedAt: null },
      data: { revokedAt: now },
    });
    expect(result).toEqual({ revokedCount: 4 });
  });

  it('revokes exact user-and-team refresh families across issuing domains', async () => {
    const prisma = makePrisma(3);

    const result = await revokeRefreshTokenFamiliesForUserTeam('user-1', 'team-1', {
      now: () => now,
      prisma,
    });

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', teamId: 'team-1', revokedAt: null },
      data: { revokedAt: now },
    });
    expect(result).toEqual({ revokedCount: 3 });
  });
});
