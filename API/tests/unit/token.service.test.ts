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
  pkceChallenge,
  useTokenServiceTestEnv,
} from './helpers/token-service-test-helpers.js';

// CLAUDE.md 500-line split of the original token.service.test.ts: authorization-code issuance
// (org claim inclusion + PKCE enforcement). The `active` claim on issuance lives in
// token.service.active-claim.test.ts; refresh-token active-claim re-validation lives in
// token.service.refresh-active-claim.test.ts. Shared helpers live in
// tests/unit/helpers/token-service-test-helpers.ts. Only the location changed — no assertion here
// was altered from the pre-split file.
describe('exchangeAuthorizationCodeForTokens (unit)', () => {
  useTokenServiceTestEnv();

  it('includes org claim in an issued JWT and round-trips the org context', async () => {
    const now = new Date('2026-02-15T00:00:00.000Z');
    const sharedSecret = process.env.SHARED_SECRET!;
    const code = 'code-with-org';
    const config = makeConfig({
      enabled: true,
      groups_enabled: true,
    });
    const clientId = createClientId(config.domain, sharedSecret);
    const configUrl = 'https://client.example.com/auth-config';
    const redirectUrl = 'https://client.example.com/oauth/callback';

    const prisma = {
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
        findMany: vi.fn(),
      },
      teamInvite: {
        findMany: vi.fn(),
      },
      groupMember: {
        findMany: vi.fn(),
      },
    } as unknown as PrismaClient;

    prisma.authorizationCode.findUnique.mockResolvedValue({
      id: 'auth-code-1',
      userId: 'user-1',
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
    prisma.refreshToken.create.mockResolvedValue({ id: 'refresh-token-1' });
    prisma.domainRole.findUnique.mockResolvedValue({
      role: 'USER',
      domain: config.domain,
      userId: 'user-1',
    });
    prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com', tokenVersion: 0 });
    prisma.orgMember.findFirst.mockResolvedValue({
      orgId: 'org-1',
      role: 'admin',
    });
    prisma.orgMember.findMany.mockResolvedValue([{ orgId: 'org-1', role: 'admin' }]);
    prisma.teamMember.findMany.mockResolvedValue([
      { teamId: 'team-1', teamRole: 'lead', team: { orgId: 'org-1' } },
      { teamId: 'team-2', teamRole: 'member', team: { orgId: 'org-1' } },
    ]);
    prisma.teamInvite.findMany.mockResolvedValue([]);
    prisma.groupMember.findMany.mockResolvedValue([
      { groupId: 'group-1', isAdmin: true },
      { groupId: 'group-2', isAdmin: false },
    ]);

    const { accessToken, refreshToken } = await exchangeAuthorizationCodeForTokens(
      { code, config, configUrl, redirectUrl, clientId, codeVerifier: TEST_CODE_VERIFIER },
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

    expect(claims).toMatchObject({
      userId: 'user-1',
      email: 'user@example.com',
      domain: config.domain,
      clientId,
      role: 'user',
      org: {
        org_id: 'org-1',
        org_role: 'admin',
        teams: ['team-1', 'team-2'],
        team_roles: {
          'team-1': 'lead',
          'team-2': 'member',
        },
        groups: ['group-1', 'group-2'],
        group_admin: ['group-1'],
      },
    });
    expect(refreshToken).toBeTypeOf('string');
  });

  it('omits the org claim when org_features is disabled', async () => {
    const now = new Date('2026-02-15T00:00:01.000Z');
    const sharedSecret = process.env.SHARED_SECRET!;
    const code = 'code-without-org';
    const config = makeConfig({ enabled: false });
    const clientId = createClientId(config.domain, sharedSecret);
    const configUrl = 'https://client.example.com/auth-config';
    const redirectUrl = 'https://client.example.com/oauth/callback';

    const prisma = {
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
      },
      teamMember: {
        findMany: vi.fn(),
      },
      groupMember: {
        findMany: vi.fn(),
      },
    } as unknown as PrismaClient;

    prisma.authorizationCode.findUnique.mockResolvedValue({
      id: 'auth-code-2',
      userId: 'user-2',
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
    prisma.refreshToken.create.mockResolvedValue({ id: 'refresh-token-2' });
    prisma.domainRole.findUnique.mockResolvedValue({
      role: 'USER',
      domain: config.domain,
      userId: 'user-2',
    });
    prisma.user.findUnique.mockResolvedValue({ email: 'user2@example.com', tokenVersion: 0 });

    const { accessToken, refreshToken } = await exchangeAuthorizationCodeForTokens(
      { code, config, configUrl, redirectUrl, clientId, codeVerifier: TEST_CODE_VERIFIER },
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

    expect(claims).toMatchObject({
      userId: 'user-2',
      email: 'user2@example.com',
      domain: config.domain,
      clientId,
      role: 'user',
    });
    expect(claims.org).toBeUndefined();
    expect(prisma.orgMember.findFirst).not.toHaveBeenCalled();
    expect(prisma.teamMember.findMany).not.toHaveBeenCalled();
    expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
    expect(refreshToken).toBeTypeOf('string');
  });

  it('omits the org claim when the user has no organisation on the domain', async () => {
    const now = new Date('2026-02-15T00:00:02.000Z');
    const sharedSecret = process.env.SHARED_SECRET!;
    const code = 'code-org-missing';
    const config = makeConfig({
      enabled: true,
      groups_enabled: true,
    });
    const clientId = createClientId(config.domain, sharedSecret);
    const configUrl = 'https://client.example.com/auth-config';
    const redirectUrl = 'https://client.example.com/oauth/callback';

    const prisma = {
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
        findMany: vi.fn(),
      },
      teamInvite: {
        findMany: vi.fn(),
      },
      groupMember: {
        findMany: vi.fn(),
      },
    } as unknown as PrismaClient;

    prisma.authorizationCode.findUnique.mockResolvedValue({
      id: 'auth-code-3',
      userId: 'user-3',
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
    prisma.refreshToken.create.mockResolvedValue({ id: 'refresh-token-3' });
    prisma.domainRole.findUnique.mockResolvedValue({
      role: 'USER',
      domain: config.domain,
      userId: 'user-3',
    });
    prisma.user.findUnique.mockResolvedValue({ email: 'user3@example.com', tokenVersion: 0 });
    prisma.orgMember.findFirst.mockResolvedValue(null);
    prisma.orgMember.findMany.mockResolvedValue([]);
    prisma.teamMember.findMany.mockResolvedValue([]);
    prisma.teamInvite.findMany.mockResolvedValue([]);

    const { accessToken, refreshToken } = await exchangeAuthorizationCodeForTokens(
      { code, config, configUrl, redirectUrl, clientId, codeVerifier: TEST_CODE_VERIFIER },
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

    expect(claims).toMatchObject({
      userId: 'user-3',
      email: 'user3@example.com',
      domain: config.domain,
      clientId,
      role: 'user',
    });
    expect(claims.org).toBeUndefined();
    expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
    expect(refreshToken).toBeTypeOf('string');
  });

  it('requires a matching PKCE verifier when the authorization code has a challenge', async () => {
    const now = new Date('2026-02-15T00:00:03.000Z');
    const sharedSecret = process.env.SHARED_SECRET!;
    const code = 'code-with-pkce';
    const codeVerifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    const config = makeConfig({ enabled: false });
    const clientId = createClientId(config.domain, sharedSecret);
    const configUrl = 'https://client.example.com/auth-config';
    const redirectUrl = 'https://client.example.com/oauth/callback';

    const prisma = {
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
      },
      teamMember: {
        findMany: vi.fn(),
      },
      groupMember: {
        findMany: vi.fn(),
      },
    } as unknown as PrismaClient;

    prisma.authorizationCode.findUnique.mockResolvedValue({
      id: 'auth-code-pkce',
      userId: 'user-pkce',
      domain: config.domain,
      configUrl,
      redirectUrl,
      codeChallenge: pkceChallenge(codeVerifier),
      codeChallengeMethod: 'S256',
      expiresAt: new Date(now.getTime() + 60_000),
      usedAt: null,
      codeHash: hashAuthorizationCode(code, sharedSecret),
    });
    prisma.authorizationCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.refreshToken.create.mockResolvedValue({ id: 'refresh-token-pkce' });
    prisma.domainRole.findUnique.mockResolvedValue({
      role: 'USER',
      domain: config.domain,
      userId: 'user-pkce',
    });
    prisma.user.findUnique.mockResolvedValue({ email: 'pkce@example.com', tokenVersion: 0 });

    await expect(
      exchangeAuthorizationCodeForTokens(
        { code, config, configUrl, redirectUrl, clientId },
        {
          now: () => now,
          sharedSecret,
          authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
          accessTokenTtl: '15m',
          prisma,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 401 });

    const result = await exchangeAuthorizationCodeForTokens(
      { code, config, configUrl, redirectUrl, codeVerifier, clientId },
      {
        now: () => now,
        sharedSecret,
        authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
        accessTokenTtl: '15m',
        prisma,
      },
    );

    expect(result.accessToken).toBeTypeOf('string');
    expect(result.refreshToken).toBeTypeOf('string');
    expect(prisma.authorizationCode.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { codeHash: hashAuthorizationCode(code, sharedSecret) },
      }),
    );
  });

  it('rejects an authorization code that has no PKCE challenge (no downgrade)', async () => {
    const now = new Date('2026-02-15T00:00:04.000Z');
    const sharedSecret = process.env.SHARED_SECRET!;
    const code = 'code-without-pkce';
    const config = makeConfig({ enabled: false });
    const clientId = createClientId(config.domain, sharedSecret);
    const configUrl = 'https://client.example.com/auth-config';
    const redirectUrl = 'https://client.example.com/oauth/callback';

    const prisma = {
      authorizationCode: { findUnique: vi.fn(), updateMany: vi.fn() },
      refreshToken: { create: vi.fn() },
      user: { findUnique: vi.fn() },
      domainRole: { findUnique: vi.fn() },
      orgMember: { findFirst: vi.fn() },
      teamMember: { findMany: vi.fn() },
      groupMember: { findMany: vi.fn() },
    } as unknown as PrismaClient;

    prisma.authorizationCode.findUnique.mockResolvedValue({
      id: 'auth-code-no-pkce',
      userId: 'user-no-pkce',
      domain: config.domain,
      configUrl,
      redirectUrl,
      // A code that somehow reached the store without a challenge must never be
      // redeemable — PKCE is mandatory on redemption.
      codeChallenge: null,
      codeChallengeMethod: null,
      expiresAt: new Date(now.getTime() + 60_000),
      usedAt: null,
      codeHash: hashAuthorizationCode(code, sharedSecret),
    });
    prisma.authorizationCode.updateMany.mockResolvedValue({ count: 1 });

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
    ).rejects.toMatchObject({ statusCode: 401 });
    // The code must not be consumed when redemption is refused.
    expect(prisma.authorizationCode.updateMany).not.toHaveBeenCalled();
  });
});
