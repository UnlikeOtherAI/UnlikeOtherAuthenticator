import { createHash } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { requestRegistrationInstructions } from '../../src/services/auth-register.service.js';
import { verifyAccessToken } from '../../src/services/access-token.service.js';
import { createAdminDomain } from '../../src/services/domain-secret.service.js';
import { encryptTwoFaSecret } from '../../src/utils/twofa-secret.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';
import { computeTotp } from '../helpers/totp.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const domain = 'client.example.com';
const configUrl = 'https://client.example.com/auth-config';
const redirectUrl = 'https://client.example.com/oauth/callback';
const codeVerifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const codeChallenge = createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');

function payload() {
  return baseClientConfigPayload({
    '2fa_enabled': true,
    existing_user_registration_behavior: 'email_login_link',
    login_flow: { email_code_enabled: true, workspace_selection: 'auto' },
    org_features: { enabled: true, user_needs_team: true },
  });
}

describe.skipIf(!hasDatabase)('existing-user registration LOGIN_LINK', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  let clientHash: string;
  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
    ACCESS_TOKEN_TTL: process.env.ACCESS_TOKEN_TTL,
  };

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.databaseUrl;
    process.env.PUBLIC_BASE_URL = 'https://auth.example.com';
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.ACCESS_TOKEN_TTL = '15m';
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    await handle.prisma.refreshToken.deleteMany();
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.verificationToken.deleteMany();
    await handle.prisma.loginLog.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.teamMember.deleteMany();
    await handle.prisma.orgMember.deleteMany();
    await handle.prisma.team.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.user.deleteMany();
    await handle.prisma.clientDomain.deleteMany({ where: { domain } });
    const domainAuth = await createAdminDomain(
      {
        domain,
        clientSecret: 'existing-login-link-client-secret-123456789',
        actorEmail: 'integration-test@example.com',
      },
      { prisma: handle.prisma },
    );
    clientHash = domainAuth.clientHash;
    await handle.prisma.clientDomain.update({
      where: { domain },
      data: { twoFaPolicy: 'OPTIONAL', allowedRedirectUrls: [] },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function requestLink(params: { email: string; rawToken: string }): Promise<string> {
    let capturedLink = '';
    const config = validateConfigFields(payload());
    const result = await requestRegistrationInstructions(
      {
        email: params.email,
        config,
        configUrl,
        redirectUrl,
        codeChallenge,
        codeChallengeMethod: 'S256',
      },
      {
        prisma: handle.prisma,
        sharedSecret: process.env.SHARED_SECRET!,
        generateEmailToken: () => params.rawToken,
        isPrincipalBannedForRegistration: async () => false,
        sendAccountExistsEmail: async ({ link }) => {
          capturedLink = link;
        },
      },
    );
    expect(result).toEqual({ status: 'sent' });
    expect(capturedLink).toContain('/auth/email/link');
    return capturedLink;
  }

  async function installConfig() {
    const jwt = await signTestConfigJwt(payload());
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));
    const app = await createApp();
    await app.ready();
    return app;
  }

  it('runs request → landing/consume → scoped 2FA → token exchange for the bound user', async () => {
    const email = 'existing@example.com';
    const totpSecret = 'JBSWY3DPEHPK3PXP';
    const user = await handle.prisma.user.create({
      data: {
        email,
        userKey: email,
        twoFaEnabled: true,
        twoFaSecret: encryptTwoFaSecret({
          secret: totpSecret,
          sharedSecret: process.env.SHARED_SECRET!,
        }),
      },
      select: { id: true },
    });
    const org = await handle.prisma.organisation.create({
      data: { domain, name: 'Existing Org', slug: 'existing-org', ownerId: user.id },
      select: { id: true },
    });
    await handle.prisma.orgMember.create({
      data: { orgId: org.id, userId: user.id, role: 'owner' },
    });
    const team = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Existing Team', slug: 'existing-team' },
      select: { id: true },
    });
    await handle.prisma.teamMember.create({
      data: { teamId: team.id, userId: user.id, teamRole: 'owner' },
    });

    const emailedLink = await requestLink({ email, rawToken: 'existing-login-link-token' });
    const tokenRowBefore = await handle.prisma.verificationToken.findFirstOrThrow({
      where: { type: 'LOGIN_LINK' },
      select: { userId: true, tokenVersion: true, usedAt: true },
    });
    expect(tokenRowBefore).toEqual({ userId: user.id, tokenVersion: 0, usedAt: null });

    const app = await installConfig();
    try {
      const landingUrl = new URL(emailedLink);
      const landing = await app.inject({
        method: 'GET',
        url: `${landingUrl.pathname}${landingUrl.search}`,
      });
      expect(landing.statusCode, landing.body).toBe(302);
      const twoFaRedirect = new URL(landing.headers.location as string, 'http://localhost');
      const twoFaToken = twoFaRedirect.searchParams.get('twofa_token');
      expect(twoFaToken).toBeTruthy();
      expect((await handle.prisma.verificationToken.findFirstOrThrow()).usedAt).not.toBeNull();
      expect(await handle.prisma.user.count({ where: { userKey: email } })).toBe(1);

      const completed = await app.inject({
        method: 'POST',
        url: `/2fa/verify?config_url=${encodeURIComponent(configUrl)}`,
        payload: {
          twofa_token: twoFaToken,
          code: computeTotp({ secret: totpSecret, nowMs: Date.now() }),
        },
      });
      expect(completed.statusCode, completed.body).toBe(200);
      const code = (completed.json() as { code: string }).code;
      expect(code).toBeTruthy();

      const tokenResponse = await app.inject({
        method: 'POST',
        url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
        headers: {
          authorization: `Bearer ${clientHash}`,
        },
        payload: {
          code,
          redirect_url: redirectUrl,
          code_verifier: codeVerifier,
        },
      });
      expect(tokenResponse.statusCode, tokenResponse.body).toBe(200);
      const accessToken = (tokenResponse.json() as { access_token: string }).access_token;
      const claims = await verifyAccessToken(accessToken, {
        sharedSecret: process.env.SHARED_SECRET!,
        issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
        prisma: handle.prisma,
      });
      expect(claims.userId).toBe(user.id);
      expect(claims.active).toEqual({ orgId: org.id, teamId: team.id });
    } finally {
      await app.close();
    }
  });

  it('fails closed if the token-bound existing account was deleted', async () => {
    const email = 'deleted@example.com';
    const user = await handle.prisma.user.create({
      data: { email, userKey: email },
      select: { id: true },
    });
    const emailedLink = await requestLink({ email, rawToken: 'deleted-user-login-link' });
    await handle.prisma.user.delete({ where: { id: user.id } });

    const app = await installConfig();
    try {
      const landingUrl = new URL(emailedLink);
      const landing = await app.inject({
        method: 'GET',
        url: `${landingUrl.pathname}${landingUrl.search}`,
      });
      expect(landing.statusCode, landing.body).toBe(200);
      expect(landing.headers.location).toBeUndefined();
      expect(await handle.prisma.user.count({ where: { userKey: email } })).toBe(0);
      expect(await handle.prisma.authorizationCode.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects stale-epoch and legacy-null links before authenticating the bound user', async () => {
    const email = 'stale-link@example.com';
    const user = await handle.prisma.user.create({
      data: { email, userKey: email },
      select: { id: true },
    });
    const staleLink = await requestLink({ email, rawToken: 'stale-user-login-link' });
    await handle.prisma.user.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
    });

    const app = await installConfig();
    try {
      const staleUrl = new URL(staleLink);
      const staleLanding = await app.inject({
        method: 'GET',
        url: `${staleUrl.pathname}${staleUrl.search}`,
      });
      expect(staleLanding.statusCode, staleLanding.body).toBe(200);
      expect(staleLanding.headers.location).toBeUndefined();

      const legacyLink = await requestLink({ email, rawToken: 'legacy-null-login-link' });
      const newest = await handle.prisma.verificationToken.findFirstOrThrow({
        where: { userId: user.id, usedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      await handle.prisma.verificationToken.update({
        where: { id: newest.id },
        data: { tokenVersion: null },
      });
      const legacyUrl = new URL(legacyLink);
      const legacyLanding = await app.inject({
        method: 'GET',
        url: `${legacyUrl.pathname}${legacyUrl.search}`,
      });
      expect(legacyLanding.statusCode, legacyLanding.body).toBe(200);
      expect(legacyLanding.headers.location).toBeUndefined();
      expect(await handle.prisma.authorizationCode.count()).toBe(0);
    } finally {
      await app.close();
    }
  });
});
