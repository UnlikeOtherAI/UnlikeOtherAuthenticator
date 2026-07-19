import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { verifyTwoFaChallenge } from '../../src/services/twofactor-challenge.service.js';
import { verifyTwoFaSetupToken } from '../../src/services/twofactor-setup-token.service.js';
import { encryptTwoFaSecret } from '../../src/utils/twofa-secret.js';
import { hashEmailToken } from '../../src/utils/verification-token.js';
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
const pkceChallenge = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

describe.skipIf(!hasDatabase)('email exact-one workspace 2FA completion', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
  };

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    await handle.prisma.clientDomain.create({
      data: { domain, label: 'Client', twoFaPolicy: 'OPTIONAL' },
    });
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
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.verificationToken.deleteMany();
    await handle.prisma.loginLog.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.teamMember.deleteMany();
    await handle.prisma.orgMember.deleteMany();
    await handle.prisma.team.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function createUserWorkspace(params: {
    email: string;
    twoFaSecret?: string;
  }): Promise<{ userId: string; orgId: string; teamId: string }> {
    const encryptedSecret = params.twoFaSecret
      ? encryptTwoFaSecret({
          secret: params.twoFaSecret,
          sharedSecret: process.env.SHARED_SECRET!,
        })
      : null;
    const user = await handle.prisma.user.create({
      data: {
        email: params.email,
        userKey: params.email,
        twoFaEnabled: Boolean(encryptedSecret),
        twoFaSecret: encryptedSecret,
      },
      select: { id: true },
    });
    const org = await handle.prisma.organisation.create({
      data: {
        domain,
        name: `Org ${params.email}`,
        slug: `org-${user.id}`,
        ownerId: user.id,
      },
      select: { id: true },
    });
    await handle.prisma.orgMember.create({
      data: { orgId: org.id, userId: user.id, role: 'owner' },
    });
    const team = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Only Team', slug: `team-${user.id}` },
      select: { id: true },
    });
    await handle.prisma.teamMember.create({
      data: { teamId: team.id, userId: user.id, teamRole: 'owner' },
    });
    return { userId: user.id, orgId: org.id, teamId: team.id };
  }

  async function createEmailToken(email: string, rawToken: string): Promise<void> {
    await handle.prisma.verificationToken.create({
      data: {
        type: 'VERIFY_EMAIL',
        email,
        userKey: email,
        domain: null,
        configUrl,
        tokenHash: hashEmailToken(rawToken, process.env.SHARED_SECRET!),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
  }

  async function installConfig(params?: { allowUserCreateOrg?: boolean }): Promise<void> {
    const jwt = await signTestConfigJwt(
      baseClientConfigPayload({
        registration_mode: 'passwordless',
        '2fa_enabled': true,
        login_flow: { email_code_enabled: false, workspace_selection: 'auto' },
        org_features: {
          enabled: true,
          user_needs_team: true,
          allow_user_create_org: params?.allowUserCreateOrg ?? false,
        },
      }),
    );
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));
  }

  it('verify-email challenge completion issues a code for the sole workspace', async () => {
    await handle.prisma.clientDomain.update({
      where: { domain },
      data: { twoFaPolicy: 'OPTIONAL' },
    });
    const email = 'email-twofa@example.com';
    const rawToken = 'email-twofa-verification-token';
    const totpSecret = 'JBSWY3DPEHPK3PXP';
    const workspace = await createUserWorkspace({ email, twoFaSecret: totpSecret });
    await createEmailToken(email, rawToken);
    await installConfig();

    const app = await createApp();
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url:
          `/auth/verify-email?config_url=${encodeURIComponent(configUrl)}` +
          `&redirect_url=${encodeURIComponent(redirectUrl)}` +
          `&code_challenge=${pkceChallenge}&code_challenge_method=S256`,
        payload: { token: rawToken },
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { twofa_required: boolean; twofa_token: string };
      expect(body.twofa_required).toBe(true);
      const challenge = await verifyTwoFaChallenge({
        token: body.twofa_token,
        sharedSecret: process.env.SHARED_SECRET!,
        audience: process.env.AUTH_SERVICE_IDENTIFIER!,
      });
      expect(challenge).toMatchObject({ orgId: workspace.orgId, teamId: workspace.teamId });

      const completed = await app.inject({
        method: 'POST',
        url: `/2fa/verify?config_url=${encodeURIComponent(configUrl)}`,
        payload: {
          twofa_token: body.twofa_token,
          code: computeTotp({ secret: totpSecret, nowMs: Date.now() }),
        },
      });
      expect(completed.statusCode, completed.body).toBe(200);
      const storedCode = await handle.prisma.authorizationCode.findFirstOrThrow({
        where: { userId: workspace.userId, usedAt: null },
        select: { orgId: true, teamId: true },
      });
      expect(storedCode).toEqual({ orgId: workspace.orgId, teamId: workspace.teamId });
    } finally {
      await app.close();
    }
  });

  it('email-link required enrollment completion issues a code for the sole workspace', async () => {
    await handle.prisma.clientDomain.update({
      where: { domain },
      data: { twoFaPolicy: 'REQUIRED' },
    });
    const email = 'email-enrollment@example.com';
    const rawToken = 'email-required-enrollment-token';
    const workspace = await createUserWorkspace({ email });
    await createEmailToken(email, rawToken);
    await installConfig();

    const app = await createApp();
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url:
          `/auth/email/link?config_url=${encodeURIComponent(configUrl)}` +
          `&redirect_url=${encodeURIComponent(redirectUrl)}` +
          `&code_challenge=${pkceChallenge}&code_challenge_method=S256` +
          `&token=${encodeURIComponent(rawToken)}`,
      });
      expect(response.statusCode, response.body).toBe(302);
      const redirect = new URL(response.headers.location as string, 'http://localhost');
      const setupToken = redirect.searchParams.get('twofa_setup_token');
      expect(redirect.searchParams.get('twofa_enroll_required')).toBe('true');
      expect(setupToken).toBeTruthy();
      const setupClaims = await verifyTwoFaSetupToken({
        token: setupToken!,
        sharedSecret: process.env.SHARED_SECRET!,
        audience: process.env.AUTH_SERVICE_IDENTIFIER!,
      });
      expect(setupClaims).toMatchObject({ orgId: workspace.orgId, teamId: workspace.teamId });

      const setup = await app.inject({
        method: 'POST',
        url: `/2fa/setup?config_url=${encodeURIComponent(configUrl)}`,
        payload: { setup_token: setupToken },
      });
      expect(setup.statusCode, setup.body).toBe(200);
      const setupBody = setup.json() as { manual_secret: string };
      const completed = await app.inject({
        method: 'POST',
        url: `/2fa/enroll?config_url=${encodeURIComponent(configUrl)}`,
        payload: {
          setup_token: setupToken,
          code: computeTotp({ secret: setupBody.manual_secret, nowMs: Date.now() }),
        },
      });
      expect(completed.statusCode, completed.body).toBe(200);
      const storedCode = await handle.prisma.authorizationCode.findFirstOrThrow({
        where: { userId: workspace.userId, usedAt: null },
        select: { orgId: true, teamId: true },
      });
      expect(storedCode).toEqual({ orgId: workspace.orgId, teamId: workspace.teamId });
    } finally {
      await app.close();
    }
  });

  it('verify-email returns the create-workspace chooser for a new zero-team user', async () => {
    const email = 'verify-create-workspace@example.com';
    const rawToken = 'verify-create-workspace-token';
    await createEmailToken(email, rawToken);
    await installConfig({ allowUserCreateOrg: true });

    const app = await createApp();
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url:
          `/auth/verify-email?config_url=${encodeURIComponent(configUrl)}` +
          `&redirect_url=${encodeURIComponent(redirectUrl)}` +
          `&code_challenge=${pkceChallenge}&code_challenge_method=S256`,
        payload: { token: rawToken },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        teams: [],
        pending_invites: [],
        can_create_org: true,
      });
      expect(typeof (response.json() as { login_token: string }).login_token).toBe('string');
      expect(await handle.prisma.authorizationCode.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('email-link redirects a new zero-team user to the create-workspace chooser', async () => {
    const email = 'link-create-workspace@example.com';
    const rawToken = 'link-create-workspace-token';
    await createEmailToken(email, rawToken);
    await installConfig({ allowUserCreateOrg: true });

    const app = await createApp();
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url:
          `/auth/email/link?config_url=${encodeURIComponent(configUrl)}` +
          `&redirect_url=${encodeURIComponent(redirectUrl)}` +
          `&code_challenge=${pkceChallenge}&code_challenge_method=S256` +
          `&token=${encodeURIComponent(rawToken)}`,
      });
      expect(response.statusCode, response.body).toBe(302);
      const redirect = new URL(response.headers.location as string, 'http://localhost');
      expect(redirect.searchParams.get('flow')).toBe('workspace_chooser');
      const loginToken = redirect.searchParams.get('login_token');
      expect(loginToken).toBeTruthy();

      const choices = await app.inject({
        method: 'POST',
        url: `/auth/session-choices?config_url=${encodeURIComponent(configUrl)}`,
        payload: { login_token: loginToken },
      });
      expect(choices.statusCode, choices.body).toBe(200);
      expect(choices.json()).toEqual({
        teams: [],
        pending_invites: [],
        can_create_org: true,
      });
      expect(await handle.prisma.authorizationCode.count()).toBe(0);
    } finally {
      await app.close();
    }
  });
});
