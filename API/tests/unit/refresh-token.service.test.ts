import { createHmac } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  exchangeRefreshToken,
  issueRefreshToken,
  REFRESH_TOKEN_REPLAY_GRACE_MS,
  revokeRefreshTokenFamily,
  revokeRefreshTokensForUserDomain,
} from '../../src/services/refresh-token.service.js';

function hashRefreshToken(token: string, sharedSecret: string): string {
  return createHmac('sha256', sharedSecret).update(token, 'utf8').digest('hex');
}

describe('refresh-token.service (unit)', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalRefreshTokenTtlDays = process.env.REFRESH_TOKEN_TTL_DAYS;

  const sharedSecret = 'test-shared-secret-with-enough-length';
  const now = new Date('2026-03-10T13:30:00.000Z');
  const context = {
    clientId: 'client-id',
    configUrl: 'https://client.example.com/auth-config',
    domain: 'client.example.com',
  };

  beforeEach(() => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.REFRESH_TOKEN_TTL_DAYS = '30';
  });

  afterEach(() => {
    if (originalSharedSecret === undefined) {
      delete process.env.SHARED_SECRET;
    } else {
      process.env.SHARED_SECRET = originalSharedSecret;
    }

    if (originalRefreshTokenTtlDays === undefined) {
      delete process.env.REFRESH_TOKEN_TTL_DAYS;
    } else {
      process.env.REFRESH_TOKEN_TTL_DAYS = originalRefreshTokenTtlDays;
    }

    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('stores only a hashed refresh token when issuing a new token', async () => {
    const prisma = {
      refreshToken: {
        create: vi.fn().mockResolvedValue({ id: 'refresh-token-1' }),
      },
    } as unknown as PrismaClient;

    const issued = await issueRefreshToken(
      {
        ...context,
        userId: 'user-1',
      },
      {
        now: () => now,
        prisma,
        refreshTokenTtlDays: 30,
        sharedSecret,
      },
    );

    expect(issued.refreshToken).toBeTypeOf('string');
    expect(issued.refreshToken).not.toBe('refresh-token-1');
    expect(issued.expiresInSeconds).toBe(30 * 24 * 60 * 60);
    expect(prisma.refreshToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tokenHash: hashRefreshToken(issued.refreshToken, sharedSecret),
        userId: 'user-1',
        familyId: expect.any(String),
        parentTokenId: undefined,
        domain: context.domain,
        clientId: context.clientId,
        configUrl: context.configUrl,
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      }),
      select: {
        id: true,
      },
    });
  });

  it('persists orgId/teamId on the created row when provided (dormant workspace scope, design §7)', async () => {
    const prisma = {
      refreshToken: {
        create: vi.fn().mockResolvedValue({ id: 'refresh-token-1' }),
      },
    } as unknown as PrismaClient;

    await issueRefreshToken(
      {
        ...context,
        userId: 'user-1',
        orgId: 'org-1',
        teamId: 'team-1',
      },
      {
        now: () => now,
        prisma,
        refreshTokenTtlDays: 30,
        sharedSecret,
      },
    );

    expect(prisma.refreshToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orgId: 'org-1', teamId: 'team-1' }),
      select: { id: true },
    });
  });

  it('defaults orgId/teamId to null when not provided', async () => {
    const prisma = {
      refreshToken: {
        create: vi.fn().mockResolvedValue({ id: 'refresh-token-1' }),
      },
    } as unknown as PrismaClient;

    await issueRefreshToken(
      {
        ...context,
        userId: 'user-1',
      },
      {
        now: () => now,
        prisma,
        refreshTokenTtlDays: 30,
        sharedSecret,
      },
    );

    expect(prisma.refreshToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orgId: null, teamId: null }),
      select: { id: true },
    });
  });

  it('rotates an active refresh token and links it to the same family', async () => {
    const currentRefreshToken = 'current-refresh-token';
    const prisma = {
      refreshToken: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'refresh-token-1',
          familyId: 'family-1',
          userId: 'user-1',
          domain: context.domain,
          clientId: context.clientId,
          configUrl: context.configUrl,
          createdAt: new Date(now.getTime() + 60_000 - 30 * 24 * 60 * 60 * 1000),
          expiresAt: new Date(now.getTime() + 60_000),
          revokedAt: null,
          replacedByTokenId: null,
        }),
        create: vi.fn().mockResolvedValue({ id: 'refresh-token-2' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;

    const rotated = await exchangeRefreshToken(
      {
        ...context,
        refreshToken: currentRefreshToken,
      },
      {
        now: () => now,
        prisma,
        refreshTokenTtlDays: 30,
        sharedSecret,
      },
    );

    expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith({
      where: {
        tokenHash: hashRefreshToken(currentRefreshToken, sharedSecret),
      },
      select: expect.any(Object),
    });
    expect(prisma.refreshToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        familyId: 'family-1',
        parentTokenId: 'refresh-token-1',
        userId: 'user-1',
        domain: context.domain,
        clientId: context.clientId,
        configUrl: context.configUrl,
      }),
      select: {
        id: true,
      },
    });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'refresh-token-1',
        revokedAt: null,
        replacedByTokenId: null,
        expiresAt: {
          gt: now,
        },
      },
      data: {
        lastUsedAt: now,
        revokedAt: now,
        replacedByTokenId: 'refresh-token-2',
      },
    });
    expect(rotated).toMatchObject({
      userId: 'user-1',
      expiresInSeconds: 30 * 24 * 60 * 60,
    });
    expect(rotated.refreshToken).toBeTypeOf('string');
    expect(rotated.refreshToken).not.toBe(currentRefreshToken);
  });

  it('carries orgId/teamId onto the rotated row and returns them (rotation preserves workspace scope)', async () => {
    const currentRefreshToken = 'scoped-refresh-token';
    const prisma = {
      refreshToken: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'refresh-token-1',
          familyId: 'family-1',
          userId: 'user-1',
          domain: context.domain,
          clientId: context.clientId,
          configUrl: context.configUrl,
          createdAt: new Date(now.getTime() + 60_000 - 30 * 24 * 60 * 60 * 1000),
          expiresAt: new Date(now.getTime() + 60_000),
          revokedAt: null,
          replacedByTokenId: null,
          orgId: 'org-1',
          teamId: 'team-1',
        }),
        create: vi.fn().mockResolvedValue({ id: 'refresh-token-2' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;

    const rotated = await exchangeRefreshToken(
      {
        ...context,
        refreshToken: currentRefreshToken,
      },
      {
        now: () => now,
        prisma,
        refreshTokenTtlDays: 30,
        sharedSecret,
      },
    );

    expect(prisma.refreshToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orgId: 'org-1', teamId: 'team-1' }),
      select: { id: true },
    });
    expect(rotated.orgId).toBe('org-1');
    expect(rotated.teamId).toBe('team-1');
  });

  it('clamps the inherited TTL when it is below the floor', async () => {
    const currentRefreshToken = 'short-refresh-token';
    const prisma = {
      refreshToken: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'refresh-token-1',
          familyId: 'family-1',
          userId: 'user-1',
          domain: context.domain,
          clientId: context.clientId,
          configUrl: context.configUrl,
          createdAt: new Date(now.getTime() - 1_000),
          expiresAt: new Date(now.getTime() + 30_000),
          revokedAt: null,
          replacedByTokenId: null,
        }),
        create: vi.fn().mockResolvedValue({ id: 'refresh-token-2' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;

    const rotated = await exchangeRefreshToken(
      {
        ...context,
        refreshToken: currentRefreshToken,
      },
      {
        now: () => now,
        prisma,
        refreshTokenTtlDays: 30,
        sharedSecret,
      },
    );

    expect(prisma.refreshToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
      }),
      select: {
        id: true,
      },
    });
    expect(rotated.expiresInSeconds).toBe(5 * 60);
  });

  it('rejects expired refresh tokens without rotating them', async () => {
    const prisma = {
      refreshToken: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'refresh-token-1',
          familyId: 'family-1',
          userId: 'user-1',
          domain: context.domain,
          clientId: context.clientId,
          configUrl: context.configUrl,
          expiresAt: new Date(now.getTime() - 1),
          revokedAt: null,
          replacedByTokenId: null,
        }),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    } as unknown as PrismaClient;

    await expect(
      exchangeRefreshToken(
        {
          ...context,
          refreshToken: 'expired-refresh-token',
        },
        {
          now: () => now,
          prisma,
          refreshTokenTtlDays: 30,
          sharedSecret,
        },
      ),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'INVALID_REFRESH_TOKEN',
    });

    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('revokes the entire family when a rotated refresh token is reused', async () => {
    const prisma = {
      user: {
        update: vi.fn().mockResolvedValue({ id: 'user-1' }),
      },
      refreshToken: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'refresh-token-1',
          familyId: 'family-1',
          userId: 'user-1',
          domain: context.domain,
          clientId: context.clientId,
          configUrl: context.configUrl,
          tokenHash: hashRefreshToken('stale-refresh-token', sharedSecret),
          parentTokenId: null,
          createdAt: new Date(now.getTime() - 60_000),
          expiresAt: new Date(now.getTime() + 60_000),
          revokedAt: new Date(now.getTime() - REFRESH_TOKEN_REPLAY_GRACE_MS - 1),
          replacedByTokenId: 'refresh-token-2',
          orgId: null,
          teamId: null,
        }),
        create: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    } as unknown as PrismaClient;

    await expect(
      exchangeRefreshToken(
        {
          ...context,
          refreshToken: 'stale-refresh-token',
        },
        {
          now: () => now,
          prisma,
          refreshTokenTtlDays: 30,
          sharedSecret,
        },
      ),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'INVALID_REFRESH_TOKEN',
    });

    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: {
        familyId: 'family-1',
        revokedAt: null,
      },
      data: {
        revokedAt: now,
      },
    });
  });

  it('revokes the refresh-token family and bumps the user token version on logout', async () => {
    const userUpdate = vi.fn().mockResolvedValue({ id: 'user-1' });
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ lockResult: '' }]),
      refreshToken: {
        findUnique: vi.fn().mockResolvedValue({
          familyId: 'family-1',
          userId: 'user-1',
          domain: context.domain,
          clientId: context.clientId,
          configUrl: context.configUrl,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      user: {
        update: userUpdate,
      },
    } as unknown as PrismaClient;

    await revokeRefreshTokenFamily(
      {
        ...context,
        refreshToken: 'active-refresh-token',
      },
      {
        now: () => now,
        prisma,
        sharedSecret,
      },
    );

    expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith({
      where: {
        tokenHash: hashRefreshToken('active-refresh-token', sharedSecret),
      },
      select: {
        familyId: true,
        userId: true,
        domain: true,
        clientId: true,
        configUrl: true,
      },
    });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: {
        familyId: 'family-1',
        revokedAt: null,
      },
      data: {
        revokedAt: now,
      },
    });
    // Logout must also revoke already-issued access tokens via a tokenVersion bump.
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { tokenVersion: { increment: 1 } },
    });
  });

  it('revokes only this domain\'s refresh tokens and does NOT bump the user token version', async () => {
    const userUpdate = vi.fn();
    const prisma = {
      refreshToken: {
        updateMany: vi.fn().mockResolvedValue({ count: 3 }),
      },
      user: {
        update: userUpdate,
      },
    } as unknown as PrismaClient;

    const result = await revokeRefreshTokensForUserDomain('user-1', context.domain, {
      now: () => now,
      prisma,
    });

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', domain: context.domain, revokedAt: null },
      data: { revokedAt: now },
    });
    expect(result).toEqual({ revokedCount: 3 });
    // Domain-scoped revocation must never touch the global per-user token version — that would
    // also invalidate the user's sessions on other domains.
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
