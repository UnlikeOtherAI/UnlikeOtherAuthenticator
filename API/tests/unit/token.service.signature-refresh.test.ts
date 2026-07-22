import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { exchangeRefreshTokenForTokens } from '../../src/services/token.service.js';
import { makeConfig, useTokenServiceTestEnv } from './helpers/token-service-test-helpers.js';

describe('exchangeRefreshTokenForTokens signature policy gate (unit)', () => {
  useTokenServiceTestEnv();

  const now = new Date('2026-07-15T21:00:00.000Z');
  const context = {
    config: makeConfig({ enabled: false }),
    configUrl: 'https://client.example.com/auth-config',
    clientId: 'client-id',
    refreshToken: 'current-refresh-token',
  };

  function makePrisma(params: {
    settings: { enabled: boolean; policyRevision: number; retentionDays: number | null } | null;
    signatureRevoked?: boolean;
    signed?: boolean;
  }) {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([{ lockResult: '' }]),
      domainSignatureSettings: {
        findUnique: vi.fn().mockResolvedValue(params.settings),
      },
      agreement: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'agreement-1',
            title: 'Terms',
            description: 'Current terms',
            displayOrder: 0,
            createdAt: now,
            versions: [
              {
                id: 'version-1',
                version: 1,
                title: 'Terms v1',
                originalFilename: 'terms.pdf',
                signingMethod: 'CLICKWRAP',
                acceptanceStatement: 'I agree',
                sourcePdfSha256: 'a'.repeat(64),
              },
            ],
          },
        ]),
      },
      agreementSignature: {
        findMany: vi.fn().mockResolvedValue(
          params.signed
            ? [
                {
                  agreementVersionId: 'version-1',
                  revocation: params.signatureRevoked ? { id: 'revocation-1' } : null,
                },
              ]
            : [],
        ),
      },
      refreshToken: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'refresh-token-1',
          familyId: 'family-1',
          userId: 'user-1',
          domain: 'client.example.com',
          clientId: 'client-id',
          configUrl: 'https://client.example.com/auth-config',
          createdAt: new Date(now.getTime() - 60_000),
          expiresAt: new Date(now.getTime() + 60_000),
          revokedAt: null,
          replacedByTokenId: null,
          orgId: null,
          teamId: null,
        }),
        create: vi.fn().mockResolvedValue({ id: 'refresh-token-2' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({ email: 'user@example.com', tokenVersion: 0 }),
      },
      domainRole: {
        findUnique: vi.fn().mockResolvedValue({
          role: 'USER',
          domain: 'client.example.com',
          userId: 'user-1',
        }),
      },
    };
    const prisma = {
      ...tx,
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    return { prisma, tx };
  }

  it('does not create, consume, or rotate a valid token when a required signature is missing', async () => {
    const { prisma, tx } = makePrisma({
      settings: { enabled: true, policyRevision: 3, retentionDays: 365 },
    });

    await expect(
      exchangeRefreshTokenForTokens(context, {
        now: () => now,
        prisma,
        adminPrisma: prisma,
        sharedSecret: process.env.SHARED_SECRET,
      }),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_REFRESH_TOKEN' });

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('treats a revoked signature as missing without consuming the refresh token', async () => {
    const { prisma, tx } = makePrisma({
      settings: { enabled: true, policyRevision: 4, retentionDays: 365 },
      signed: true,
      signatureRevoked: true,
    });

    await expect(
      exchangeRefreshTokenForTokens(context, {
        now: () => now,
        prisma,
        adminPrisma: prisma,
        sharedSecret: process.env.SHARED_SECRET,
      }),
    ).rejects.toThrowError('INVALID_REFRESH_TOKEN');

    expect(tx.refreshToken.create).not.toHaveBeenCalled();
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('locks policy state and rotates normally when the current signature is valid', async () => {
    const { prisma, tx } = makePrisma({
      settings: { enabled: true, policyRevision: 5, retentionDays: 365 },
      signed: true,
    });

    const result = await exchangeRefreshTokenForTokens(context, {
      now: () => now,
      prisma,
      adminPrisma: prisma,
      sharedSecret: process.env.SHARED_SECRET,
      authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
    });

    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.refreshToken.create).toHaveBeenCalledOnce();
    expect(tx.refreshToken.updateMany).toHaveBeenCalledOnce();
    expect(result.accessToken).toBeTypeOf('string');
    expect(result.refreshToken).toBeTypeOf('string');
  });

  it('preserves legacy refresh behavior when the domain service is disabled', async () => {
    const { prisma, tx } = makePrisma({
      settings: { enabled: false, policyRevision: 8, retentionDays: 365 },
    });

    await exchangeRefreshTokenForTokens(context, {
      now: () => now,
      prisma,
      adminPrisma: prisma,
      sharedSecret: process.env.SHARED_SECRET,
      authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
    });

    expect(tx.agreement.findMany).not.toHaveBeenCalled();
    expect(tx.agreementSignature.findMany).not.toHaveBeenCalled();
    expect(tx.refreshToken.create).toHaveBeenCalledOnce();
    expect(tx.refreshToken.updateMany).toHaveBeenCalledOnce();
  });
});
