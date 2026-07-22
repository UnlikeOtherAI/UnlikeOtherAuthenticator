import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const emailMocks = vi.hoisted(() => ({
  sendAccessRequestNotificationEmail: vi.fn(),
}));

vi.mock('../../src/services/email.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/email.service.js')>();
  return {
    ...actual,
    sendAccessRequestNotificationEmail: emailMocks.sendAccessRequestNotificationEmail,
  };
});

import type { ClientConfig } from '../../src/services/config.service.js';
import { createApp } from '../../src/app.js';
import { LOGIN_SESSION_AUDIENCE } from '../../src/config/constants.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { signLoginSession } from '../../src/services/login-session.service.js';
import { hashEmailToken } from '../../src/utils/verification-token.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const domain = 'client.example.com';
const configUrl = 'https://client.example.com/auth-config';
const redirectUrl = 'https://client.example.com/oauth/callback';
const challenge = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

type Workspace = {
  ownerId: string;
  orgId: string;
  teamId: string;
};

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function configPayload(overrides?: Record<string, unknown>) {
  return baseClientConfigPayload({
    redirect_urls: [redirectUrl],
    login_flow: { email_code_enabled: true, workspace_selection: 'auto' },
    org_features: { enabled: true, user_needs_team: true },
    ...overrides,
  });
}

describe.skipIf(!hasDatabase)('login continuation transaction races', () => {
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
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await handle.prisma.refreshToken.deleteMany();
    await handle.prisma.loginSessionUse.deleteMany();
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.loginLog.deleteMany();
    await handle.prisma.accessRequest.deleteMany();
    await handle.prisma.orgAuditLog.deleteMany();
    await handle.prisma.teamInviteLink.deleteMany();
    await handle.prisma.teamInvite.deleteMany();
    await handle.prisma.domainRole.deleteMany();
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
  });

  async function seedWorkspace(): Promise<Workspace> {
    const owner = await handle.prisma.user.create({
      data: {
        email: 'owner@example.com',
        userKey: 'owner@example.com',
        name: 'Owner',
      },
      select: { id: true },
    });
    const org = await handle.prisma.organisation.create({
      data: { domain, name: 'Race Org', slug: `org-${owner.id}`, ownerId: owner.id },
      select: { id: true },
    });
    await handle.prisma.orgMember.create({
      data: { orgId: org.id, userId: owner.id, role: 'owner' },
    });
    const team = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Race Team', slug: `team-${owner.id}` },
      select: { id: true },
    });
    await handle.prisma.teamMember.create({
      data: { teamId: team.id, userId: owner.id, teamRole: 'owner' },
    });
    return { ownerId: owner.id, orgId: org.id, teamId: team.id };
  }

  async function seedUser(email: string): Promise<string> {
    const user = await handle.prisma.user.create({
      data: { email, userKey: email, name: 'Requester' },
      select: { id: true },
    });
    return user.id;
  }

  async function installConfig(payload: ReturnType<typeof configPayload>) {
    const jwt = await signTestConfigJwt(payload);
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));
    const app = await createApp();
    await app.ready();
    return app;
  }

  async function mint(params: {
    userId: string;
    config: ClientConfig;
    jti: string;
    requestAccess?: boolean;
  }): Promise<string> {
    return signLoginSession({
      userId: params.userId,
      authMethod: 'email_password',
      config: params.config,
      configUrl,
      redirectUrl,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      rememberMe: true,
      requestAccess: params.requestAccess ?? false,
      jti: params.jti,
      sharedSecret: process.env.SHARED_SECRET!,
      audience: LOGIN_SESSION_AUDIENCE,
    });
  }

  function selectUrl(requestAccess = false): string {
    const url = new URL('/auth/select-team', 'http://localhost');
    url.searchParams.set('config_url', configUrl);
    url.searchParams.set('redirect_url', redirectUrl);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (requestAccess) url.searchParams.set('request_access', 'true');
    return `${url.pathname}${url.search}`;
  }

  it('lets only the claimed request create and notify an access request', async () => {
    const workspace = await seedWorkspace();
    const userId = await seedUser('requester@example.com');
    const payload = configPayload({
      access_requests: {
        enabled: true,
        target_org_id: workspace.orgId,
        target_team_id: workspace.teamId,
        notify_org_roles: ['owner'],
      },
    });
    const config = validateConfigFields(payload);
    const loginToken = await mint({
      userId,
      config,
      jti: 'concurrent-access-request',
      requestAccess: true,
    });
    const emailStarted = deferred();
    const releaseEmail = deferred();
    emailMocks.sendAccessRequestNotificationEmail.mockImplementationOnce(async () => {
      emailStarted.resolve();
      await releaseEmail.promise;
    });
    const app = await installConfig(payload);

    try {
      const winner = app.inject({
        method: 'POST',
        url: selectUrl(true),
        payload: { login_token: loginToken },
      });
      await emailStarted.promise;
      const replay = app.inject({
        method: 'POST',
        url: selectUrl(true),
        payload: { login_token: loginToken },
      });
      releaseEmail.resolve();

      const responses = await Promise.all([winner, replay]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401]);
      expect(emailMocks.sendAccessRequestNotificationEmail).toHaveBeenCalledTimes(1);
      expect(await handle.prisma.accessRequest.count()).toBe(1);
      expect(await handle.prisma.loginSessionUse.count()).toBe(1);
      expect(await handle.prisma.authorizationCode.count()).toBe(0);
    } finally {
      releaseEmail.resolve();
      await app.close();
    }
  });

  it('rolls back a failed notification and leaves the capability retryable', async () => {
    const workspace = await seedWorkspace();
    const userId = await seedUser('retry-requester@example.com');
    const payload = configPayload({
      access_requests: {
        enabled: true,
        target_org_id: workspace.orgId,
        target_team_id: workspace.teamId,
        notify_org_roles: ['owner'],
      },
    });
    const config = validateConfigFields(payload);
    const loginToken = await mint({
      userId,
      config,
      jti: 'failed-notification-retry',
      requestAccess: true,
    });
    emailMocks.sendAccessRequestNotificationEmail
      .mockRejectedValueOnce(new Error('mail unavailable'))
      .mockResolvedValueOnce(undefined);
    const app = await installConfig(payload);

    try {
      const failed = await app.inject({
        method: 'POST',
        url: selectUrl(true),
        payload: { login_token: loginToken },
      });
      expect(failed.statusCode).toBe(500);
      expect(await handle.prisma.loginSessionUse.count()).toBe(0);
      expect(await handle.prisma.accessRequest.count()).toBe(0);

      const retried = await app.inject({
        method: 'POST',
        url: selectUrl(true),
        payload: { login_token: loginToken },
      });
      expect(retried.statusCode, retried.body).toBe(200);
      expect(emailMocks.sendAccessRequestNotificationEmail).toHaveBeenCalledTimes(2);
      expect(await handle.prisma.loginSessionUse.count()).toBe(1);
      expect(await handle.prisma.accessRequest.count()).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('redeems an invite link and records its audit exactly once under replay', async () => {
    const workspace = await seedWorkspace();
    const userId = await seedUser('invitee@example.com');
    const token = 'concurrent-invite-link-token';
    const link = await handle.prisma.teamInviteLink.create({
      data: {
        orgId: workspace.orgId,
        teamId: workspace.teamId,
        tokenHash: hashEmailToken(token, process.env.SHARED_SECRET!),
        createdByUserId: workspace.ownerId,
        expiresAt: new Date(Date.now() + 60_000),
        maxUses: 5,
      },
      select: { id: true },
    });
    const payload = configPayload();
    const loginToken = await mint({
      userId,
      config: validateConfigFields(payload),
      jti: 'concurrent-invite-link',
    });
    const app = await installConfig(payload);

    try {
      const request = () =>
        app.inject({
          method: 'POST',
          url: selectUrl(),
          payload: { login_token: loginToken, inviteLinkToken: token },
        });
      const responses = await Promise.all([request(), request()]);

      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401]);
      expect(await handle.prisma.loginSessionUse.count()).toBe(1);
      expect(await handle.prisma.authorizationCode.count({ where: { userId } })).toBe(1);
      expect(
        await handle.prisma.teamInviteLink.findUniqueOrThrow({
          where: { id: link.id },
          select: { useCount: true },
        }),
      ).toEqual({ useCount: 1 });
      expect(
        await handle.prisma.orgMember.count({
          where: { orgId: workspace.orgId, userId, status: 'ACTIVE' },
        }),
      ).toBe(1);
      expect(
        await handle.prisma.teamMember.count({
          where: { teamId: workspace.teamId, userId, status: 'ACTIVE' },
        }),
      ).toBe(1);
      expect(
        await handle.prisma.orgAuditLog.count({
          where: {
            orgId: workspace.orgId,
            actorUserId: userId,
            action: 'team_member.added',
          },
        }),
      ).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('does not consume or reactivate an invite link for an inactive org member', async () => {
    const workspace = await seedWorkspace();
    const userId = await seedUser('inactive-invitee@example.com');
    await handle.prisma.orgMember.create({
      data: {
        orgId: workspace.orgId,
        userId,
        role: 'member',
        status: 'DEACTIVATED',
        statusChangedAt: new Date(),
      },
    });
    await handle.prisma.teamMember.create({
      data: {
        teamId: workspace.teamId,
        userId,
        teamRole: 'member',
        status: 'REMOVED',
        statusChangedAt: new Date(),
      },
    });
    const token = 'inactive-member-invite-link-token';
    const link = await handle.prisma.teamInviteLink.create({
      data: {
        orgId: workspace.orgId,
        teamId: workspace.teamId,
        tokenHash: hashEmailToken(token, process.env.SHARED_SECRET!),
        createdByUserId: workspace.ownerId,
        expiresAt: new Date(Date.now() + 60_000),
      },
      select: { id: true },
    });
    const payload = configPayload();
    const loginToken = await mint({
      userId,
      config: validateConfigFields(payload),
      jti: 'inactive-org-invite-link',
    });
    const app = await installConfig(payload);

    try {
      const response = await app.inject({
        method: 'POST',
        url: selectUrl(),
        payload: { login_token: loginToken, inviteLinkToken: token },
      });
      expect(response.statusCode).toBe(400);
      expect(await handle.prisma.loginSessionUse.count()).toBe(0);
      expect(await handle.prisma.authorizationCode.count()).toBe(0);
      expect(
        await handle.prisma.teamInviteLink.findUniqueOrThrow({
          where: { id: link.id },
          select: { useCount: true },
        }),
      ).toEqual({ useCount: 0 });
      expect(
        await handle.prisma.orgMember.findUniqueOrThrow({
          where: { orgId_userId: { orgId: workspace.orgId, userId } },
          select: { status: true },
        }),
      ).toEqual({ status: 'DEACTIVATED' });
      expect(
        await handle.prisma.teamMember.findUniqueOrThrow({
          where: { teamId_userId: { teamId: workspace.teamId, userId } },
          select: { status: true },
        }),
      ).toEqual({ status: 'REMOVED' });
      expect(await handle.prisma.orgAuditLog.count()).toBe(0);
    } finally {
      await app.close();
    }
  });
});
