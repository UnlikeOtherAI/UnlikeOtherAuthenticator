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
    crossDomain?: boolean;
    domain?: string;
    storedOrgId: string | null;
    storedTeamId: string | null;
    contextTeamIds: string[];
  }) {
    const now = new Date('2026-07-07T01:00:00.000Z');
    const domain = params.domain ?? 'client.example.com';
    const configUrl = `https://${domain}/auth-config`;
    return {
      configUrl,
      now,
      prisma: {
        $executeRaw: vi.fn().mockResolvedValue(1),
        domainSignatureSettings: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
        refreshToken: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'refresh-token-1',
            familyId: 'family-1',
            userId: 'user-1',
            domain,
            clientId: 'client-id',
            configUrl,
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
            domain,
            userId: 'user-1',
          }),
        },
        clientDomain: {
          findUnique: vi.fn().mockResolvedValue({ status: 'active' }),
        },
        billingAppKey: {
          findMany: vi.fn().mockResolvedValue([
            {
              serviceId: 'service-deepsignal',
              service: { identifier: 'deepsignal' },
            },
          ]),
        },
        orgMember: {
          findFirst: vi.fn(async (args: { where?: { org?: unknown } }) =>
            params.crossDomain && args.where?.org
              ? null
              : { orgId: params.storedOrgId, role: 'member' },
          ),
        },
        teamMember: {
          findMany: vi
            .fn()
            .mockResolvedValue(
              params.contextTeamIds.map((teamId) => ({ teamId, teamRole: 'member' })),
            ),
        },
      } as unknown as PrismaClient,
    };
  }

  it("keeps the active claim, including first-login placement, when the rotated token's workspace remains ACTIVE", async () => {
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

  it('rejects refresh when the selected team membership is no longer active', async () => {
    const { now, prisma } = makeRotationPrisma({
      storedOrgId: 'org-1',
      storedTeamId: 'team-removed',
      contextTeamIds: ['team-1'],
    });
    const sharedSecret = process.env.SHARED_SECRET!;
    const config = makeConfig({ enabled: true, groups_enabled: false });
    const clientId = 'client-id';
    const configUrl = 'https://client.example.com/auth-config';

    await expect(
      exchangeRefreshTokenForTokens(
        { config, configUrl, refreshToken: 'current-refresh-token', clientId },
        {
          now: () => now,
          sharedSecret,
          authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
          accessTokenTtl: '15m',
          prisma,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_REFRESH_TOKEN' });
  });

  it('retains a valid stored active scope even when org_features display is disabled', async () => {
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

    expect(claims.active).toEqual({ orgId: 'org-1', teamId: 'team-1' });
    expect(prisma.orgMember.findFirst).toHaveBeenCalled();
  });

  it('retains a cross-domain scope only for the exact active product mapping', async () => {
    const { configUrl, now, prisma } = makeRotationPrisma({
      crossDomain: true,
      domain: 'api.deepsignal.live',
      storedOrgId: 'org-nessie',
      storedTeamId: 'team-nessie',
      contextTeamIds: ['team-nessie'],
    });
    const sharedSecret = process.env.SHARED_SECRET!;
    const config = {
      ...makeConfig({ enabled: false }),
      domain: 'api.deepsignal.live',
    };

    const { accessToken } = await exchangeRefreshTokenForTokens(
      {
        config,
        configUrl,
        refreshToken: 'current-refresh-token',
        clientId: 'client-id',
      },
      {
        now: () => now,
        sharedSecret,
        authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
        accessTokenTtl: '15m',
        adminPrisma: prisma,
        prisma,
      },
    );

    const claims = await verifyAccessToken(accessToken, {
      sharedSecret,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
      prisma,
    });
    expect(claims.active).toEqual({ orgId: 'org-nessie', teamId: 'team-nessie' });
    expect(prisma.billingAppKey.findMany).toHaveBeenCalled();
  });

  it('rejects a cross-domain refresh after its product key is revoked', async () => {
    const { configUrl, now, prisma } = makeRotationPrisma({
      crossDomain: true,
      domain: 'api.deepsignal.live',
      storedOrgId: 'org-nessie',
      storedTeamId: 'team-nessie',
      contextTeamIds: ['team-nessie'],
    });
    prisma.billingAppKey.findMany.mockResolvedValue([]);
    const config = {
      ...makeConfig({ enabled: false }),
      domain: 'api.deepsignal.live',
    };

    await expect(
      exchangeRefreshTokenForTokens(
        {
          config,
          configUrl,
          refreshToken: 'current-refresh-token',
          clientId: 'client-id',
        },
        {
          now: () => now,
          sharedSecret: process.env.SHARED_SECRET!,
          adminPrisma: prisma,
          prisma,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_REFRESH_TOKEN' });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
