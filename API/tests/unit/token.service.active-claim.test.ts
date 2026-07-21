import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { createClientId } from '../../src/utils/hash.js';
import { exchangeAuthorizationCodeForTokens } from '../../src/services/token.service.js';
import { verifyAccessToken } from '../../src/services/access-token.service.js';
import {
  hashAuthorizationCode,
  makeConfig,
  TEST_CODE_CHALLENGE,
  TEST_CODE_VERIFIER,
  useTokenServiceTestEnv,
} from './helpers/token-service-test-helpers.js';

// CLAUDE.md 500-line split of the original token.service.test.ts — see token.service.test.ts
// (issuance/org-claim/PKCE) and token.service.refresh-active-claim.test.ts (refresh re-validation)
// for the rest. Only the location changed — no assertion here was altered from the pre-split file.
//
// `active` workspace-scope claim emitted from authorization_codes.org_id/team_id.
describe('exchangeAuthorizationCodeForTokens active claim (unit)', () => {
  useTokenServiceTestEnv();

  function makePrisma() {
    return {
      $queryRaw: vi.fn().mockResolvedValue([]),
      authorizationCode: {
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
      refreshToken: {
        create: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
      domainRole: {
        findUnique: vi.fn(),
      },
      orgMember: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      teamMember: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      teamInvite: { findMany: vi.fn() },
      clientDomain: { findUnique: vi.fn() },
      billingAppKey: { findMany: vi.fn() },
      organisation: { create: vi.fn() },
      team: { create: vi.fn() },
    } as unknown as PrismaClient;
  }

  it('emits the active claim and persists it on the refresh token when the code carries both orgId and teamId', async () => {
    const now = new Date('2026-07-07T00:00:00.000Z');
    const sharedSecret = process.env.SHARED_SECRET!;
    const code = 'code-with-active-scope';
    const config = makeConfig({ enabled: false });
    const clientId = createClientId(config.domain, sharedSecret);
    const configUrl = 'https://client.example.com/auth-config';
    const redirectUrl = 'https://client.example.com/oauth/callback';

    const prisma = makePrisma();
    prisma.authorizationCode.findUnique.mockResolvedValue({
      id: 'auth-code-active',
      userId: 'user-active',
      domain: config.domain,
      configUrl,
      redirectUrl,
      codeChallenge: TEST_CODE_CHALLENGE,
      codeChallengeMethod: 'S256',
      expiresAt: new Date(now.getTime() + 60_000),
      usedAt: null,
      codeHash: hashAuthorizationCode(code, sharedSecret),
      orgId: 'org-active',
      teamId: 'team-active',
    });
    prisma.authorizationCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'org-member-active',
      orgId: 'org-active',
      role: 'member',
    });
    prisma.teamMember.findFirst.mockResolvedValue({ id: 'team-member-active' });
    prisma.teamMember.findMany.mockResolvedValue([{ teamId: 'team-active', teamRole: 'member' }]);
    prisma.refreshToken.create.mockResolvedValue({ id: 'refresh-token-active' });
    prisma.domainRole.findUnique.mockResolvedValue({
      role: 'USER',
      domain: config.domain,
      userId: 'user-active',
    });
    prisma.user.findUnique.mockResolvedValue({ email: 'active@example.com', tokenVersion: 0 });

    const { accessToken } = await exchangeAuthorizationCodeForTokens(
      { code, config, configUrl, redirectUrl, clientId, codeVerifier: TEST_CODE_VERIFIER },
      {
        now: () => now,
        sharedSecret,
        authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
        accessTokenTtl: '15m',
        prisma,
      },
    );

    expect(prisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgId: 'org-active', teamId: 'team-active' }),
      }),
    );

    const claims = await verifyAccessToken(accessToken, {
      sharedSecret,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
      prisma,
    });

    expect(claims.active).toEqual({ orgId: 'org-active', teamId: 'team-active' });
  });

  it('resolves one cross-product workspace for an unscoped off-flow without creating a ghost product workspace', async () => {
    const now = new Date('2026-07-07T00:00:00.500Z');
    const sharedSecret = process.env.SHARED_SECRET!;
    const code = 'code-with-cross-product-scope';
    const config = {
      ...makeConfig({ enabled: true, groups_enabled: false, user_needs_team: true }),
      domain: 'api.deepsignal.live',
      login_flow: { email_code_enabled: false, workspace_selection: 'off' as const },
    };
    const clientId = createClientId(config.domain, sharedSecret);
    const configUrl = 'https://api.deepsignal.live/auth-config';
    const redirectUrl = 'https://api.deepsignal.live/oauth/callback';
    const prisma = makePrisma();

    prisma.authorizationCode.findUnique.mockResolvedValue({
      id: 'auth-code-cross',
      userId: 'user-active',
      domain: config.domain,
      configUrl,
      redirectUrl,
      codeChallenge: TEST_CODE_CHALLENGE,
      codeChallengeMethod: 'S256',
      expiresAt: new Date(now.getTime() + 60_000),
      usedAt: null,
    });
    prisma.authorizationCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.orgMember.findFirst.mockImplementation(async (args: { where: { org?: unknown } }) =>
      args.where.org ? null : { id: 'org-member-nessie', orgId: 'org-nessie', role: 'member' },
    );
    prisma.teamMember.findFirst.mockImplementation(
      async (args: { where: { team?: { org?: unknown } } }) =>
        args.where.team?.org ? null : { id: 'team-member-nessie' },
    );
    prisma.orgMember.findMany.mockImplementation(async (args: { where: { org?: unknown } }) =>
      args.where.org ? [] : [{ orgId: 'org-nessie', role: 'member' }],
    );
    prisma.teamMember.findMany.mockImplementation(
      async (args: { where: { team?: { orgId?: string; org?: unknown } } }) => {
        if (args.where.team?.orgId) {
          return [{ teamId: 'team-nessie', teamRole: 'member' }];
        }
        const org = args.where.team?.org;
        if (org && typeof org === 'object' && 'members' in org) {
          return [
            {
              teamId: 'team-nessie',
              teamRole: 'member',
              team: { orgId: 'org-nessie', iconUrl: null },
            },
          ];
        }
        return [];
      },
    );
    prisma.teamInvite.findMany.mockResolvedValue([]);
    prisma.clientDomain.findUnique.mockResolvedValue({ status: 'active' });
    prisma.billingAppKey.findMany.mockResolvedValue([
      {
        serviceId: 'service-deepsignal',
        service: { identifier: 'deepsignal' },
      },
    ]);
    prisma.refreshToken.create.mockResolvedValue({ id: 'refresh-token-active' });
    prisma.domainRole.findUnique.mockResolvedValue({
      role: 'USER',
      domain: config.domain,
      userId: 'user-active',
    });
    prisma.user.findUnique.mockResolvedValue({
      email: 'active@example.com',
      tokenVersion: 0,
    });

    const { accessToken, firstLogin } = await exchangeAuthorizationCodeForTokens(
      { code, config, configUrl, redirectUrl, clientId, codeVerifier: TEST_CODE_VERIFIER },
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
    expect(firstLogin?.memberships.teams).toContainEqual({
      teamId: 'team-nessie',
      orgId: 'org-nessie',
      role: 'member',
      iconUrl: null,
    });
    expect(prisma.organisation.create).not.toHaveBeenCalled();
    expect(prisma.team.create).not.toHaveBeenCalled();
  });

  it('fails closed if a product mapping is revoked after code validation but before signing', async () => {
    const now = new Date('2026-07-07T00:00:00.750Z');
    const sharedSecret = process.env.SHARED_SECRET!;
    const config = {
      ...makeConfig({ enabled: false }),
      domain: 'api.deepsignal.live',
    };
    const configUrl = 'https://api.deepsignal.live/auth-config';
    const redirectUrl = 'https://api.deepsignal.live/oauth/callback';
    const prisma = makePrisma();
    prisma.authorizationCode.findUnique.mockResolvedValue({
      id: 'auth-code-revoked-race',
      userId: 'user-active',
      domain: config.domain,
      configUrl,
      redirectUrl,
      codeChallenge: TEST_CODE_CHALLENGE,
      codeChallengeMethod: 'S256',
      expiresAt: new Date(now.getTime() + 60_000),
      usedAt: null,
      orgId: 'org-nessie',
      teamId: 'team-nessie',
    });
    prisma.authorizationCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.orgMember.findFirst.mockImplementation(async (args: { where: { org?: unknown } }) =>
      args.where.org ? null : { id: 'org-member-nessie', orgId: 'org-nessie', role: 'member' },
    );
    prisma.teamMember.findFirst.mockImplementation(
      async (args: { where: { team?: { org?: unknown } } }) =>
        args.where.team?.org ? null : { id: 'team-member-nessie' },
    );
    prisma.clientDomain.findUnique.mockResolvedValue({ status: 'active' });
    prisma.billingAppKey.findMany
      .mockResolvedValueOnce([
        {
          serviceId: 'service-deepsignal',
          service: { identifier: 'deepsignal' },
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.refreshToken.create.mockResolvedValue({ id: 'refresh-token-active' });
    prisma.domainRole.findUnique.mockResolvedValue({
      role: 'USER',
      domain: config.domain,
      userId: 'user-active',
    });
    prisma.user.findUnique.mockResolvedValue({
      email: 'active@example.com',
      tokenVersion: 0,
    });

    await expect(
      exchangeAuthorizationCodeForTokens(
        {
          code: 'code-revoked-race',
          config,
          configUrl,
          redirectUrl,
          clientId: createClientId(config.domain, sharedSecret),
          codeVerifier: TEST_CODE_VERIFIER,
        },
        { now: () => now, sharedSecret, adminPrisma: prisma, prisma },
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'AUTHENTICATION_FAILED' });
  });

  it('rejects a malformed authorization code carrying only part of a workspace scope', async () => {
    const now = new Date('2026-07-07T00:00:01.000Z');
    const sharedSecret = process.env.SHARED_SECRET!;
    const code = 'code-with-partial-scope';
    const config = makeConfig({ enabled: false });
    const clientId = createClientId(config.domain, sharedSecret);
    const configUrl = 'https://client.example.com/auth-config';
    const redirectUrl = 'https://client.example.com/oauth/callback';

    const prisma = makePrisma();
    prisma.authorizationCode.findUnique.mockResolvedValue({
      id: 'auth-code-partial',
      userId: 'user-partial',
      domain: config.domain,
      configUrl,
      redirectUrl,
      codeChallenge: TEST_CODE_CHALLENGE,
      codeChallengeMethod: 'S256',
      expiresAt: new Date(now.getTime() + 60_000),
      usedAt: null,
      codeHash: hashAuthorizationCode(code, sharedSecret),
      orgId: 'org-only',
      teamId: null,
    });
    prisma.authorizationCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.refreshToken.create.mockResolvedValue({ id: 'refresh-token-partial' });
    prisma.domainRole.findUnique.mockResolvedValue({
      role: 'USER',
      domain: config.domain,
      userId: 'user-partial',
    });
    prisma.user.findUnique.mockResolvedValue({ email: 'partial@example.com', tokenVersion: 0 });

    await expect(
      exchangeAuthorizationCodeForTokens(
        { code, config, configUrl, redirectUrl, clientId, codeVerifier: TEST_CODE_VERIFIER },
        {
          now: () => now,
          sharedSecret,
          authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
          accessTokenTtl: '15m',
          prisma,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_AUTH_CODE' });
    expect(prisma.authorizationCode.updateMany).not.toHaveBeenCalled();
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('rejects exchange when the exact scoped memberships are no longer ACTIVE', async () => {
    const now = new Date('2026-07-07T00:00:01.500Z');
    const sharedSecret = process.env.SHARED_SECRET!;
    const code = 'code-with-inactive-scope';
    const config = makeConfig({ enabled: false });
    const clientId = createClientId(config.domain, sharedSecret);
    const configUrl = 'https://client.example.com/auth-config';
    const redirectUrl = 'https://client.example.com/oauth/callback';
    const prisma = makePrisma();
    prisma.authorizationCode.findUnique.mockResolvedValue({
      id: 'auth-code-inactive',
      userId: 'user-inactive',
      domain: config.domain,
      configUrl,
      redirectUrl,
      codeChallenge: TEST_CODE_CHALLENGE,
      codeChallengeMethod: 'S256',
      expiresAt: new Date(now.getTime() + 60_000),
      usedAt: null,
      orgId: 'org-inactive',
      teamId: 'team-inactive',
    });
    prisma.orgMember.findFirst.mockResolvedValue(null);
    prisma.teamMember.findFirst.mockResolvedValue({ id: 'team-member-inactive' });

    await expect(
      exchangeAuthorizationCodeForTokens(
        { code, config, configUrl, redirectUrl, clientId, codeVerifier: TEST_CODE_VERIFIER },
        { now: () => now, sharedSecret, prisma },
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_AUTH_CODE' });
    expect(prisma.authorizationCode.updateMany).not.toHaveBeenCalled();
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('omits the active claim when the code carries neither orgId nor teamId', async () => {
    const now = new Date('2026-07-07T00:00:02.000Z');
    const sharedSecret = process.env.SHARED_SECRET!;
    const code = 'code-with-no-scope';
    const config = makeConfig({ enabled: false });
    const clientId = createClientId(config.domain, sharedSecret);
    const configUrl = 'https://client.example.com/auth-config';
    const redirectUrl = 'https://client.example.com/oauth/callback';

    const prisma = makePrisma();
    prisma.authorizationCode.findUnique.mockResolvedValue({
      id: 'auth-code-none',
      userId: 'user-none',
      domain: config.domain,
      configUrl,
      redirectUrl,
      codeChallenge: TEST_CODE_CHALLENGE,
      codeChallengeMethod: 'S256',
      expiresAt: new Date(now.getTime() + 60_000),
      usedAt: null,
      codeHash: hashAuthorizationCode(code, sharedSecret),
    });
    prisma.authorizationCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.refreshToken.create.mockResolvedValue({ id: 'refresh-token-none' });
    prisma.domainRole.findUnique.mockResolvedValue({
      role: 'USER',
      domain: config.domain,
      userId: 'user-none',
    });
    prisma.user.findUnique.mockResolvedValue({ email: 'none@example.com', tokenVersion: 0 });

    const { accessToken } = await exchangeAuthorizationCodeForTokens(
      { code, config, configUrl, redirectUrl, clientId, codeVerifier: TEST_CODE_VERIFIER },
      {
        now: () => now,
        sharedSecret,
        authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
        accessTokenTtl: '15m',
        prisma,
      },
    );

    expect(prisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgId: null, teamId: null }),
      }),
    );

    const claims = await verifyAccessToken(accessToken, {
      sharedSecret,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
      prisma,
    });

    expect(claims.active).toBeUndefined();
  });
});
