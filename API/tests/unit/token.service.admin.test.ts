import { createHash, createHmac } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { verifyAccessToken } from '../../src/services/access-token.service.js';
import { exchangeAuthorizationCodeForTokens } from '../../src/services/token.service.js';
import { createClientId } from '../../src/utils/hash.js';

function hashAuthorizationCode(code: string, sharedSecret: string): string {
  return createHmac('sha256', sharedSecret).update(code, 'utf8').digest('hex');
}

// PKCE is mandatory on redemption; exercise the secure path.
const TEST_CODE_VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const TEST_CODE_CHALLENGE = createHash('sha256')
  .update(TEST_CODE_VERIFIER, 'utf8')
  .digest('base64url');

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

describe('admin-domain token issuance', () => {
  const originalAdminDomain = process.env.ADMIN_AUTH_DOMAIN;
  const originalAdminTokenSecret = process.env.ADMIN_ACCESS_TOKEN_SECRET;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalIssuer = process.env.AUTH_SERVICE_IDENTIFIER;
  const originalAccessTokenTtl = process.env.ACCESS_TOKEN_TTL;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://localhost:5432/authenticator_test';
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.ADMIN_AUTH_DOMAIN = 'admin.example.com';
    process.env.ADMIN_ACCESS_TOKEN_SECRET = 'admin-token-secret-with-enough-length';
    process.env.ACCESS_TOKEN_TTL = '30m';
  });

  afterEach(() => {
    restoreEnv('ADMIN_AUTH_DOMAIN', originalAdminDomain);
    restoreEnv('ADMIN_ACCESS_TOKEN_SECRET', originalAdminTokenSecret);
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    restoreEnv('SHARED_SECRET', originalSharedSecret);
    restoreEnv('AUTH_SERVICE_IDENTIFIER', originalIssuer);
    restoreEnv('ACCESS_TOKEN_TTL', originalAccessTokenTtl);
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('signs access tokens for the admin auth domain with the admin-only secret', async () => {
    const now = new Date('2026-04-21T10:00:00.000Z');
    const sharedSecret = process.env.SHARED_SECRET!;
    const adminSecret = process.env.ADMIN_ACCESS_TOKEN_SECRET!;
    const code = 'admin-code';
    const config = {
      domain: 'admin.example.com',
      org_features: { enabled: false },
    } as unknown as ClientConfig;
    const configUrl = 'https://admin.example.com/auth-config';
    const redirectUrl = 'https://admin.example.com/oauth/callback';

    const prisma = {
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
      clientDomain: { findUnique: vi.fn().mockResolvedValue(null) },
      billingAppKey: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;

    prisma.authorizationCode.findUnique.mockResolvedValue({
      id: 'auth-code-admin',
      userId: 'admin-user',
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
    prisma.refreshToken.create.mockResolvedValue({ id: 'refresh-token-admin' });
    prisma.domainRole.findUnique.mockResolvedValue({
      role: 'SUPERUSER',
      domain: config.domain,
      userId: 'admin-user',
    });
    prisma.user.findUnique.mockResolvedValue({ email: 'admin@example.com', tokenVersion: 0 });

    const { accessToken } = await exchangeAuthorizationCodeForTokens(
      { code, config, configUrl, redirectUrl, codeVerifier: TEST_CODE_VERIFIER },
      {
        now: () => now,
        sharedSecret,
        authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
        accessTokenTtl: '15m',
        prisma,
      },
    );

    await expect(
      verifyAccessToken(accessToken, {
        sharedSecret,
        issuer: process.env.AUTH_SERVICE_IDENTIFIER,
        prisma,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });

    const claims = await verifyAccessToken(accessToken, {
      sharedSecret: adminSecret,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
      prisma,
    });

    expect(claims).toMatchObject({
      userId: 'admin-user',
      domain: 'admin.example.com',
      role: 'superuser',
    });
    expect(claims.clientId).toBe('admin:admin.example.com');
    expect(claims.clientId).not.toBe(createClientId(config.domain, sharedSecret));
  });

  it('marks a platform superuser (SUPERUSER on ADMIN_AUTH_DOMAIN) as superuser on a client-domain token', async () => {
    const now = new Date('2026-04-21T10:00:00.000Z');
    const sharedSecret = process.env.SHARED_SECRET!;
    const code = 'client-code';
    const config = {
      domain: 'client.example.com',
      org_features: { enabled: false },
    } as unknown as ClientConfig;
    const configUrl = 'https://client.example.com/auth-config';
    const redirectUrl = 'https://client.example.com/oauth/callback';
    const clientId = createClientId(config.domain, sharedSecret);

    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      authorizationCode: { findUnique: vi.fn(), updateMany: vi.fn() },
      refreshToken: { create: vi.fn() },
      user: { findUnique: vi.fn() },
      domainRole: { findUnique: vi.fn() },
      clientDomain: { findUnique: vi.fn().mockResolvedValue(null) },
      billingAppKey: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;

    prisma.authorizationCode.findUnique.mockResolvedValue({
      id: 'auth-code-client',
      userId: 'client-user',
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
    prisma.refreshToken.create.mockResolvedValue({ id: 'refresh-token-client' });
    // USER on the client domain, but SUPERUSER on ADMIN_AUTH_DOMAIN (admin-panel grant).
    prisma.domainRole.findUnique.mockImplementation(
      async (args: { where: { domain_userId: { domain: string } } }) => {
        const domain = args.where.domain_userId.domain;
        return domain === 'admin.example.com'
          ? { role: 'SUPERUSER', domain, userId: 'client-user' }
          : { role: 'USER', domain, userId: 'client-user' };
      },
    );
    prisma.user.findUnique.mockResolvedValue({ email: 'operator@example.com', tokenVersion: 0 });

    const { accessToken } = await exchangeAuthorizationCodeForTokens(
      { code, config, configUrl, redirectUrl, clientId, codeVerifier: TEST_CODE_VERIFIER },
      {
        now: () => now,
        sharedSecret,
        authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
        accessTokenTtl: '15m',
        prisma,
        adminPrisma: prisma,
      },
    );

    const claims = await verifyAccessToken(accessToken, {
      sharedSecret,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
      prisma,
    });

    expect(claims).toMatchObject({
      userId: 'client-user',
      domain: 'client.example.com',
      clientId,
      role: 'superuser',
    });
  });
});
