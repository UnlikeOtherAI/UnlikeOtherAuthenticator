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
// Phase 3a (dormant): `active` workspace-scope claim. Nothing populates
// authorization_codes.org_id/team_id yet, but the plumbing must already behave
// correctly once Phase 3b starts writing them.
describe('exchangeAuthorizationCodeForTokens active claim (unit)', () => {
  useTokenServiceTestEnv();

  function makePrisma() {
    return {
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

  it('omits the active claim when the code carries only one of orgId/teamId', async () => {
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

    const claims = await verifyAccessToken(accessToken, {
      sharedSecret,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
      prisma,
    });

    expect(claims.active).toBeUndefined();
  });

  it('omits the active claim when the code carries neither orgId nor teamId (today\'s dormant default)', async () => {
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
