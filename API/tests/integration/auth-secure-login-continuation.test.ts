import { createHash } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { createApp } from '../../src/app.js';
import { LOGIN_SESSION_AUDIENCE } from '../../src/config/constants.js';
import {
  consumeAuthorizationCode,
  issueAuthorizationCode,
} from '../../src/services/authorization-code.service.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { signLoginSession } from '../../src/services/login-session.service.js';
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
const otherRedirectUrl = 'https://client.example.com/other-callback';
const challenge = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

type Workspace = { userId: string; orgId: string; teamId: string };

function configPayload(overrides?: Record<string, unknown>) {
  return baseClientConfigPayload({
    redirect_urls: [redirectUrl, otherRedirectUrl],
    login_flow: { email_code_enabled: true, workspace_selection: 'auto' },
    org_features: { enabled: true, user_needs_team: true },
    ...overrides,
  });
}

function parsedConfig(overrides?: Record<string, unknown>): ClientConfig {
  return validateConfigFields(configPayload(overrides));
}

describe.skipIf(!hasDatabase)('secure one-time login continuation', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
  };

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.databaseUrl;
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
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
    await handle.prisma.loginSessionUse.deleteMany();
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.loginLog.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.teamInvite.deleteMany();
    await handle.prisma.teamMember.deleteMany();
    await handle.prisma.orgMember.deleteMany();
    await handle.prisma.team.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.user.deleteMany();
    await handle.prisma.clientDomain.upsert({
      where: { domain },
      create: { domain, label: 'Client', twoFaPolicy: 'OPTIONAL' },
      update: { allowedRedirectUrls: [], twoFaPolicy: 'OPTIONAL' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function seedWorkspace(params?: {
    email?: string;
    totpSecret?: string;
  }): Promise<Workspace> {
    const email = params?.email ?? 'chooser@example.com';
    const encryptedSecret = params?.totpSecret
      ? encryptTwoFaSecret({
          secret: params.totpSecret,
          sharedSecret: process.env.SHARED_SECRET!,
        })
      : null;
    const user = await handle.prisma.user.create({
      data: {
        email,
        userKey: email,
        twoFaEnabled: Boolean(encryptedSecret),
        twoFaSecret: encryptedSecret,
      },
      select: { id: true },
    });
    const org = await handle.prisma.organisation.create({
      data: { domain, name: 'Chooser Org', slug: `org-${user.id}`, ownerId: user.id },
      select: { id: true },
    });
    await handle.prisma.orgMember.create({
      data: { orgId: org.id, userId: user.id, role: 'owner' },
    });
    const team = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Chooser Team', slug: `team-${user.id}` },
      select: { id: true },
    });
    await handle.prisma.teamMember.create({
      data: { teamId: team.id, userId: user.id, teamRole: 'owner' },
    });
    return { userId: user.id, orgId: org.id, teamId: team.id };
  }

  async function installConfig(overrides?: Record<string, unknown>) {
    const jwt = await signTestConfigJwt(configPayload(overrides));
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));
    const app = await createApp();
    await app.ready();
    return app;
  }

  async function mint(userId: string, config: ClientConfig, jti: string) {
    return await signLoginSession({
      userId,
      authMethod: 'email_password',
      config,
      configUrl,
      redirectUrl,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      rememberMe: true,
      requestAccess: false,
      jti,
      sharedSecret: process.env.SHARED_SECRET!,
      audience: LOGIN_SESSION_AUDIENCE,
    });
  }

  function selectUrl(params?: {
    redirect?: string;
    codeChallenge?: string;
    requestAccess?: boolean;
  }): string {
    const url = new URL('/auth/select-team', 'http://localhost');
    url.searchParams.set('config_url', configUrl);
    url.searchParams.set('redirect_url', params?.redirect ?? redirectUrl);
    url.searchParams.set('code_challenge', params?.codeChallenge ?? challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (params?.requestAccess) url.searchParams.set('request_access', 'true');
    return `${url.pathname}${url.search}`;
  }

  it('rejects every caller retarget while leaving the capability usable', async () => {
    const workspace = await seedWorkspace();
    const config = parsedConfig();
    const loginToken = await mint(workspace.userId, config, 'retarget-jti');
    const app = await installConfig();
    try {
      const attempts = [
        {
          name: 'redirect',
          url: selectUrl({ redirect: otherRedirectUrl }),
          payload: { login_token: loginToken, teamId: workspace.teamId },
        },
        {
          name: 'pkce',
          url: selectUrl({ codeChallenge: `${challenge}x` }),
          payload: { login_token: loginToken, teamId: workspace.teamId },
        },
        {
          name: 'request access',
          url: selectUrl({ requestAccess: true }),
          payload: { login_token: loginToken, teamId: workspace.teamId },
        },
        {
          name: 'remember me',
          url: selectUrl(),
          payload: { login_token: loginToken, teamId: workspace.teamId, remember_me: false },
        },
      ];
      for (const attempt of attempts) {
        const response = await app.inject({
          method: 'POST',
          url: attempt.url,
          payload: attempt.payload,
        });
        expect(response.statusCode, `${attempt.name}: ${response.body}`).toBe(401);
      }
      expect(await handle.prisma.loginSessionUse.count()).toBe(0);
      expect(await handle.prisma.authorizationCode.count()).toBe(0);

      const valid = await app.inject({
        method: 'POST',
        url: selectUrl(),
        payload: { login_token: loginToken, teamId: workspace.teamId },
      });
      expect(valid.statusCode, valid.body).toBe(200);
      expect(await handle.prisma.loginSessionUse.count()).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('binds the same config URL to the verified parsed config fingerprint', async () => {
    const workspace = await seedWorkspace();
    const loginToken = await mint(workspace.userId, parsedConfig(), 'config-change-jti');
    const app = await installConfig({ allow_registration: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/auth/session-choices?config_url=${encodeURIComponent(configUrl)}`,
        payload: { login_token: loginToken },
      });
      expect(response.statusCode, response.body).toBe(401);
      expect(await handle.prisma.loginSessionUse.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('keeps choices and decline non-consuming, then grants exactly once', async () => {
    const workspace = await seedWorkspace({ email: 'decline@example.com' });
    const invite = await handle.prisma.teamInvite.create({
      data: {
        orgId: workspace.orgId,
        teamId: workspace.teamId,
        email: 'decline@example.com',
        invitedByUserId: workspace.userId,
        lastSentAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
      select: { id: true },
    });
    const loginToken = await mint(workspace.userId, parsedConfig(), 'one-time-jti');
    const app = await installConfig();
    try {
      const choices = await app.inject({
        method: 'POST',
        url: `/auth/session-choices?config_url=${encodeURIComponent(configUrl)}`,
        payload: { login_token: loginToken },
      });
      expect(choices.statusCode, choices.body).toBe(200);
      expect(await handle.prisma.loginSessionUse.count()).toBe(0);

      const decline = await app.inject({
        method: 'POST',
        url: selectUrl(),
        payload: { login_token: loginToken, inviteId: invite.id, action: 'decline' },
      });
      expect(decline.statusCode, decline.body).toBe(200);
      expect(await handle.prisma.loginSessionUse.count()).toBe(0);

      const selected = await app.inject({
        method: 'POST',
        url: selectUrl(),
        payload: { login_token: loginToken, teamId: workspace.teamId },
      });
      expect(selected.statusCode, selected.body).toBe(200);
      const use = await handle.prisma.loginSessionUse.findFirstOrThrow({
        select: { jtiHash: true },
      });
      expect(use.jtiHash).toMatch(/^[a-f0-9]{64}$/);
      expect(use.jtiHash).not.toContain('one-time-jti');

      const replay = await app.inject({
        method: 'POST',
        url: selectUrl(),
        payload: { login_token: loginToken, teamId: workspace.teamId },
      });
      expect(replay.statusCode, replay.body).toBe(401);
      expect(await handle.prisma.loginSessionUse.count()).toBe(1);
      expect(await handle.prisma.authorizationCode.count()).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('commits personal invite acceptance and capability consumption together', async () => {
    const ownerWorkspace = await seedWorkspace({ email: 'owner-invite@example.com' });
    const invitee = await handle.prisma.user.create({
      data: { email: 'invited@example.com', userKey: 'invited@example.com' },
      select: { id: true },
    });
    const invite = await handle.prisma.teamInvite.create({
      data: {
        orgId: ownerWorkspace.orgId,
        teamId: ownerWorkspace.teamId,
        email: 'invited@example.com',
        invitedByUserId: ownerWorkspace.userId,
        lastSentAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
      select: { id: true },
    });
    const loginToken = await mint(invitee.id, parsedConfig(), 'invite-accept-jti');
    const app = await installConfig();
    try {
      const selected = await app.inject({
        method: 'POST',
        url: selectUrl(),
        payload: { login_token: loginToken, inviteId: invite.id },
      });
      expect(selected.statusCode, selected.body).toBe(200);
      expect(
        await handle.prisma.teamInvite.findUniqueOrThrow({
          where: { id: invite.id },
          select: { acceptedUserId: true },
        }),
      ).toEqual({ acceptedUserId: invitee.id });
      expect(
        await handle.prisma.orgMember.count({
          where: { orgId: ownerWorkspace.orgId, userId: invitee.id, status: 'ACTIVE' },
        }),
      ).toBe(1);
      expect(
        await handle.prisma.teamMember.count({
          where: { teamId: ownerWorkspace.teamId, userId: invitee.id, status: 'ACTIVE' },
        }),
      ).toBe(1);

      const replay = await app.inject({
        method: 'POST',
        url: selectUrl(),
        payload: { login_token: loginToken, inviteId: invite.id },
      });
      expect(replay.statusCode, replay.body).toBe(401);
      expect(await handle.prisma.authorizationCode.count({ where: { userId: invitee.id } })).toBe(
        1,
      );
      expect(await handle.prisma.loginSessionUse.count()).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('cannot replay a selection or finish 2FA after membership removal', async () => {
    const totpSecret = 'JBSWY3DPEHPK3PXP';
    const workspace = await seedWorkspace({ email: 'twofa@example.com', totpSecret });
    const config = parsedConfig({ '2fa_enabled': true });
    const loginToken = await mint(workspace.userId, config, 'twofa-jti');
    const app = await installConfig({ '2fa_enabled': true });
    try {
      const selected = await app.inject({
        method: 'POST',
        url: selectUrl(),
        payload: { login_token: loginToken, teamId: workspace.teamId },
      });
      expect(selected.statusCode, selected.body).toBe(200);
      const twofaToken = (selected.json() as { twofa_token: string }).twofa_token;
      expect(twofaToken).toBeTruthy();
      expect(await handle.prisma.loginSessionUse.count()).toBe(1);

      const replay = await app.inject({
        method: 'POST',
        url: selectUrl(),
        payload: { login_token: loginToken, teamId: workspace.teamId },
      });
      expect(replay.statusCode, replay.body).toBe(401);

      await handle.prisma.orgMember.update({
        where: { orgId_userId: { orgId: workspace.orgId, userId: workspace.userId } },
        data: { status: 'DEACTIVATED', statusChangedAt: new Date() },
      });
      const completed = await app.inject({
        method: 'POST',
        url: `/2fa/verify?config_url=${encodeURIComponent(configUrl)}`,
        payload: {
          twofa_token: twofaToken,
          code: computeTotp({ secret: totpSecret, nowMs: Date.now() }),
        },
      });
      expect(completed.statusCode, completed.body).toBe(401);
      expect(await handle.prisma.authorizationCode.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects code exchange if the exact workspace membership became inactive', async () => {
    const workspace = await seedWorkspace({ email: 'exchange-inactive@example.com' });
    const verifier = 'exchange-verifier-abcdefghijklmnopqrstuvwxyz0123456789';
    const exchangeChallenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
    const issued = await issueAuthorizationCode(
      {
        userId: workspace.userId,
        domain,
        configUrl,
        redirectUrl,
        codeChallenge: exchangeChallenge,
        codeChallengeMethod: 'S256',
        rememberMe: true,
        twoFaCompleted: false,
        orgId: workspace.orgId,
        teamId: workspace.teamId,
      },
      {
        prisma: handle.prisma,
        sharedSecret: process.env.SHARED_SECRET!,
      },
    );

    await handle.prisma.teamMember.update({
      where: {
        teamId_userId: {
          teamId: workspace.teamId,
          userId: workspace.userId,
        },
      },
      data: { status: 'REMOVED', statusChangedAt: new Date() },
    });

    await expect(
      consumeAuthorizationCode({
        code: issued.code,
        configUrl,
        domain,
        redirectUrl,
        codeVerifier: verifier,
        now: new Date(),
        sharedSecret: process.env.SHARED_SECRET!,
        prisma: handle.prisma,
      }),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_AUTH_CODE' });
    expect(
      await handle.prisma.authorizationCode.findFirstOrThrow({
        where: { userId: workspace.userId },
        select: { usedAt: true },
      }),
    ).toEqual({ usedAt: null });
  });
});
