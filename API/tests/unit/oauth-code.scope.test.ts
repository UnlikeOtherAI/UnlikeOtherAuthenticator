import { createHash } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  consumeOAuthCode,
  issueOAuthCode,
} from '../../src/services/oauth/oauth-code.service.js';

describe('public OAuth code scope binding', () => {
  const originalSecret = process.env.SHARED_SECRET;
  const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  beforeEach(() => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
  });

  afterEach(() => {
    if (originalSecret === undefined) Reflect.deleteProperty(process.env, 'SHARED_SECRET');
    else process.env.SHARED_SECRET = originalSecret;
  });

  it('stores the authorize-time scope on the one-time code', async () => {
    const prisma = {
      authorizationCode: { create: vi.fn().mockResolvedValue({ id: 'code-1' }) },
    } as unknown as Prisma.TransactionClient;
    await issueOAuthCode(
      {
        userId: 'user-1',
        domain: 'mcp.example.com',
        oauthClientId: 'client-1',
        redirectUrl: 'https://tool.example/callback',
        scope: 'openid profile',
        codeChallenge: challenge,
      },
      prisma,
      new Date('2026-07-15T20:00:00.000Z'),
    );

    expect(prisma.authorizationCode.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ oauthScope: 'openid profile' }),
      select: { id: true },
    });
  });

  it('returns only the scope bound to the redeemed code', async () => {
    const now = new Date('2026-07-15T20:00:00.000Z');
    const prisma = {
      authorizationCode: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'code-1',
          userId: 'user-1',
          oauthClientId: 'client-1',
          redirectUrl: 'https://tool.example/callback',
          resource: 'https://resource.example',
          oauthScope: 'openid profile',
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
          rememberMe: false,
          expiresAt: new Date(now.getTime() + 60_000),
          usedAt: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(
      consumeOAuthCode(
        {
          code: 'opaque-code',
          oauthClientId: 'client-1',
          redirectUrl: 'https://tool.example/callback',
          codeVerifier: verifier,
        },
        prisma,
        now,
      ),
    ).resolves.toEqual({
      userId: 'user-1',
      resource: 'https://resource.example',
      scope: 'openid profile',
      rememberMe: false,
    });
  });
});
