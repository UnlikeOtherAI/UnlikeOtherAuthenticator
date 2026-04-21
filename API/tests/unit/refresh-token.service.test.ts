import { createHmac } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  exchangeRefreshToken,
  issueRefreshToken,
  revokeRefreshTokenFamily,
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
      refreshToken: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'refresh-token-1',
          familyId: 'family-1',
          userId: 'user-1',
          domain: context.domain,
          clientId: context.clientId,
          configUrl: context.configUrl,
          expiresAt: new Date(now.getTime() + 60_000),
          revokedAt: null,
          replacedByTokenId: 'refresh-token-2',
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

  it('revokes the refresh-token family on logout for the matching client context', async () => {
    const prisma = {
      refreshToken: {
        findUnique: vi.fn().mockResolvedValue({
          familyId: 'family-1',
          domain: context.domain,
          clientId: context.clientId,
          configUrl: context.configUrl,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
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
  });
});
