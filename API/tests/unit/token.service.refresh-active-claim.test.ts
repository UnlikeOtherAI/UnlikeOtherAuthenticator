import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { exchangeRefreshTokenForTokens } from '../../src/services/token.service.js';
import { verifyAccessToken } from '../../src/services/access-token.service.js';
import { makeConfig, useTokenServiceTestEnv } from './helpers/token-service-test-helpers.js';

// CLAUDE.md 500-line split of the original token.service.test.ts — see token.service.test.ts
// (issuance/org-claim/PKCE) and token.service.active-claim.test.ts (issuance active claim) for the
// rest. Only the location changed — no assertion here was altered from the pre-split file.
describe('exchangeRefreshTokenForTokens active-claim re-validation (unit)', () => {
  useTokenServiceTestEnv();

  function makeRotationPrisma(params: {
    storedOrgId: string | null;
    storedTeamId: string | null;
    contextTeamIds: string[];
  }) {
    const now = new Date('2026-07-07T01:00:00.000Z');
    return {
      now,
      prisma: {
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn().mockResolvedValue([{ lockResult: '' }]),
        domainSignatureSettings: {
          findUnique: vi.fn().mockResolvedValue(null),
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
            orgId: params.storedOrgId,
            teamId: params.storedTeamId,
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
        orgMember: {
          findFirst: vi.fn().mockResolvedValue({ orgId: params.storedOrgId, role: 'member' }),
        },
        teamMember: {
          findMany: vi.fn().mockResolvedValue(
            params.contextTeamIds.map((teamId) => ({ teamId, teamRole: 'member' })),
          ),
        },
      } as unknown as PrismaClient,
    };
  }

  it('keeps the active claim when the rotated token\'s workspace is still an ACTIVE membership', async () => {
    const { now, prisma } = makeRotationPrisma({
      storedOrgId: 'org-1',
      storedTeamId: 'team-1',
      contextTeamIds: ['team-1', 'team-2'],
    });
    const sharedSecret = process.env.SHARED_SECRET!;
    const config = makeConfig({ enabled: true, groups_enabled: false });
    // Must match the mocked refresh-token row's clientId for matchesRefreshTokenContext to accept it.
    const clientId = 'client-id';
    const configUrl = 'https://client.example.com/auth-config';

    const { accessToken } = await exchangeRefreshTokenForTokens(
      { config, configUrl, refreshToken: 'current-refresh-token', clientId },
      {
        now: () => now,
        sharedSecret,
        authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
        accessTokenTtl: '15m',
        prisma,
      },
    );

    const claims = await verifyAccessToken(accessToken, {
      sharedSecret,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
      prisma,
    });

    expect(claims.active).toEqual({ orgId: 'org-1', teamId: 'team-1' });
    expect(prisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgId: 'org-1', teamId: 'team-1' }),
      }),
    );
  });

  it('drops the active claim on refresh when the team membership is no longer in the resolved org context', async () => {
    const { now, prisma } = makeRotationPrisma({
      storedOrgId: 'org-1',
      storedTeamId: 'team-removed',
      contextTeamIds: ['team-1'],
    });
    const sharedSecret = process.env.SHARED_SECRET!;
    const config = makeConfig({ enabled: true, groups_enabled: false });
    const clientId = 'client-id';
    const configUrl = 'https://client.example.com/auth-config';

    const { accessToken } = await exchangeRefreshTokenForTokens(
      { config, configUrl, refreshToken: 'current-refresh-token', clientId },
      {
        now: () => now,
        sharedSecret,
        authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
        accessTokenTtl: '15m',
        prisma,
      },
    );

    const claims = await verifyAccessToken(accessToken, {
      sharedSecret,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
      prisma,
    });

    expect(claims.active).toBeUndefined();
  });

  it('never emits active when org_features is disabled, even if the stored refresh token carries scope', async () => {
    const { now, prisma } = makeRotationPrisma({
      storedOrgId: 'org-1',
      storedTeamId: 'team-1',
      contextTeamIds: ['team-1'],
    });
    const sharedSecret = process.env.SHARED_SECRET!;
    const config = makeConfig({ enabled: false });
    const clientId = 'client-id';
    const configUrl = 'https://client.example.com/auth-config';

    const { accessToken } = await exchangeRefreshTokenForTokens(
      { config, configUrl, refreshToken: 'current-refresh-token', clientId },
      {
        now: () => now,
        sharedSecret,
        authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
        accessTokenTtl: '15m',
        prisma,
      },
    );

    const claims = await verifyAccessToken(accessToken, {
      sharedSecret,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
      prisma,
    });

    expect(claims.active).toBeUndefined();
    expect(prisma.orgMember.findFirst).not.toHaveBeenCalled();
  });
});
