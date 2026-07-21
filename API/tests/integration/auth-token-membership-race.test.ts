import { createHash } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { issueAuthorizationCode } from '../../src/services/authorization-code.service.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { deactivateOrganisationMember } from '../../src/services/organisation.service.lifecycle.js';
import { revokeRefreshTokensForUserDomain } from '../../src/services/refresh-token.service.js';
import { exchangeAuthorizationCodeForTokens } from '../../src/services/token.service.js';
import { createClientId } from '../../src/utils/hash.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const domain = 'client.example.com';
const configUrl = 'https://client.example.com/auth-config';
const redirectUrl = 'https://client.example.com/oauth/callback';
const verifier = 'membership-race-verifier-abcdefghijklmnopqrstuvwxyz';

type SeededWorkspace = {
  ownerId: string;
  userId: string;
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

function config(workspaceSelection: 'off' | 'auto' = 'off'): ClientConfig {
  return validateConfigFields(
    baseClientConfigPayload({
      redirect_urls: [redirectUrl],
      login_flow: { email_code_enabled: false, workspace_selection: workspaceSelection },
      org_features: { enabled: true, user_needs_team: true },
      session: {
        remember_me_enabled: true,
        remember_me_default: true,
        short_refresh_token_ttl_hours: 1,
        long_refresh_token_ttl_days: 30,
        access_token_ttl_minutes: 15,
      },
    }),
  );
}

describe.skipIf(!hasDatabase)('authorization-code and membership lifecycle race', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
    ACCESS_TOKEN_TTL: process.env.ACCESS_TOKEN_TTL,
  };

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.databaseUrl;
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.ACCESS_TOKEN_TTL = '15m';
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    await handle.prisma.refreshToken.deleteMany();
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.orgAuditLog.deleteMany();
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

  async function seedWorkspace(): Promise<SeededWorkspace> {
    const owner = await handle.prisma.user.create({
      data: { email: 'owner@example.com', userKey: 'owner@example.com' },
      select: { id: true },
    });
    const user = await handle.prisma.user.create({
      data: { email: 'member@example.com', userKey: 'member@example.com' },
      select: { id: true },
    });
    const org = await handle.prisma.organisation.create({
      data: { domain, name: 'Token Race Org', slug: `org-${owner.id}`, ownerId: owner.id },
      select: { id: true },
    });
    await handle.prisma.orgMember.createMany({
      data: [
        { orgId: org.id, userId: owner.id, role: 'owner' },
        { orgId: org.id, userId: user.id, role: 'member' },
      ],
    });
    const team = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Token Race Team', slug: `team-${owner.id}` },
      select: { id: true },
    });
    await handle.prisma.teamMember.createMany({
      data: [
        { teamId: team.id, userId: owner.id, teamRole: 'owner' },
        { teamId: team.id, userId: user.id, teamRole: 'member' },
      ],
    });
    return { ownerId: owner.id, userId: user.id, orgId: org.id, teamId: team.id };
  }

  async function issueCode(workspace: SeededWorkspace): Promise<string> {
    const codeChallenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
    const issued = await issueAuthorizationCode(
      {
        userId: workspace.userId,
        domain,
        configUrl,
        redirectUrl,
        codeChallenge,
        codeChallengeMethod: 'S256',
        rememberMe: true,
        orgId: workspace.orgId,
        teamId: workspace.teamId,
      },
      {
        prisma: handle.prisma,
        sharedSecret: process.env.SHARED_SECRET!,
      },
    );
    return issued.code;
  }

  async function issueUnscopedCode(userId: string): Promise<string> {
    const codeChallenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
    const issued = await issueAuthorizationCode(
      {
        userId,
        domain,
        configUrl,
        redirectUrl,
        codeChallenge,
        codeChallengeMethod: 'S256',
        rememberMe: true,
      },
      { prisma: handle.prisma, sharedSecret: process.env.SHARED_SECRET! },
    );
    return issued.code;
  }

  function exchange(code: string, afterActiveWorkspaceLock?: () => Promise<void>) {
    return exchangeAuthorizationCodeForTokens(
      {
        code,
        config: config(),
        configUrl,
        redirectUrl,
        codeVerifier: verifier,
        clientId: createClientId(domain, process.env.SHARED_SECRET!),
      },
      {
        prisma: handle.prisma,
        adminPrisma: handle.prisma,
        sharedSecret: process.env.SHARED_SECRET!,
        afterActiveWorkspaceLock,
      },
    );
  }

  function exchangeRequired(code: string, afterRequiredWorkspaceLock?: () => Promise<void>) {
    return exchangeAuthorizationCodeForTokens(
      {
        code,
        config: config('auto'),
        configUrl,
        redirectUrl,
        codeVerifier: verifier,
        clientId: createClientId(domain, process.env.SHARED_SECRET!),
      },
      {
        prisma: handle.prisma,
        adminPrisma: handle.prisma,
        sharedSecret: process.env.SHARED_SECRET!,
        afterRequiredWorkspaceLock,
      },
    );
  }

  function deactivate(
    workspace: SeededWorkspace,
    afterMembershipStatusWrite?: () => Promise<void>,
    revokeRealRefreshTokens = false,
  ) {
    return deactivateOrganisationMember(
      {
        orgId: workspace.orgId,
        domain,
        actorUserId: workspace.ownerId,
        userId: workspace.userId,
      },
      {
        prisma: handle.prisma,
        revokeRefreshTokensForUserDomain: revokeRealRefreshTokens
          ? (userId, targetDomain) =>
              revokeRefreshTokensForUserDomain(userId, targetDomain, { prisma: handle.prisma })
          : async () => ({ revokedCount: 0 }),
        afterMembershipStatusWrite,
      },
    );
  }

  async function expectStillPending(promise: Promise<unknown>): Promise<void> {
    const state = await Promise.race([
      promise.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]);
    expect(state).toBe('pending');
  }

  it('rejects exchange when deactivation obtains the membership locks first', async () => {
    const workspace = await seedWorkspace();
    const code = await issueCode(workspace);
    const statusWritten = deferred();
    const releaseDeactivation = deferred();

    const deactivation = deactivate(workspace, async () => {
      statusWritten.resolve();
      await releaseDeactivation.promise;
    });
    await statusWritten.promise;

    const tokenExchange = exchange(code);
    await expectStillPending(tokenExchange);
    releaseDeactivation.resolve();

    await expect(deactivation).resolves.toEqual({ deactivated: true });
    await expect(tokenExchange).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_AUTH_CODE',
    });
    expect(
      await handle.prisma.authorizationCode.findFirstOrThrow({
        where: { userId: workspace.userId },
        select: { usedAt: true },
      }),
    ).toEqual({ usedAt: null });
    expect(await handle.prisma.refreshToken.count()).toBe(0);
  });

  it('finishes exchange before a deactivation waiting on the same locks', async () => {
    const workspace = await seedWorkspace();
    const code = await issueCode(workspace);
    const scopeLocked = deferred();
    const releaseExchange = deferred();

    const tokenExchange = exchange(code, async () => {
      scopeLocked.resolve();
      await releaseExchange.promise;
    });
    await scopeLocked.promise;

    const deactivation = deactivate(workspace);
    await expectStillPending(deactivation);
    releaseExchange.resolve();

    const tokens = await tokenExchange;
    expect(tokens.accessToken.length).toBeGreaterThan(20);
    expect(tokens.refreshToken.length).toBeGreaterThan(20);
    await expect(deactivation).resolves.toEqual({ deactivated: true });
    expect(
      await handle.prisma.authorizationCode.findFirstOrThrow({
        where: { userId: workspace.userId },
        select: { usedAt: true },
      }),
    ).toEqual({ usedAt: expect.any(Date) });
    expect(await handle.prisma.refreshToken.count({ where: { userId: workspace.userId } })).toBe(1);
    expect(
      await handle.prisma.orgMember.findUniqueOrThrow({
        where: { orgId_userId: { orgId: workspace.orgId, userId: workspace.userId } },
        select: { status: true },
      }),
    ).toEqual({ status: 'DEACTIVATED' });
  });

  it('rejects an unscoped required exchange when deactivation locks the resolved workspace first', async () => {
    const workspace = await seedWorkspace();
    const code = await issueUnscopedCode(workspace.userId);
    const statusWritten = deferred();
    const releaseDeactivation = deferred();

    const deactivation = deactivate(workspace, async () => {
      statusWritten.resolve();
      await releaseDeactivation.promise;
    });
    await statusWritten.promise;

    const tokenExchange = exchangeRequired(code);
    await expectStillPending(tokenExchange);
    releaseDeactivation.resolve();

    await expect(deactivation).resolves.toEqual({ deactivated: true });
    await expect(tokenExchange).rejects.toMatchObject({ statusCode: 401 });
    expect(await handle.prisma.refreshToken.count()).toBe(0);
  });

  it('commits required placement before waiting deactivation revokes the newly issued refresh', async () => {
    const workspace = await seedWorkspace();
    const code = await issueUnscopedCode(workspace.userId);
    const placementLocked = deferred();
    const releaseExchange = deferred();

    const tokenExchange = exchangeRequired(code, async () => {
      placementLocked.resolve();
      await releaseExchange.promise;
    });
    await placementLocked.promise;

    const deactivation = deactivate(workspace, undefined, true);
    await expectStillPending(deactivation);
    releaseExchange.resolve();

    const tokens = await tokenExchange;
    expect(tokens.accessToken.length).toBeGreaterThan(20);
    await expect(deactivation).resolves.toEqual({ deactivated: true });
    expect(
      await handle.prisma.refreshToken.findFirstOrThrow({
        where: { userId: workspace.userId },
        select: { orgId: true, teamId: true, revokedAt: true },
      }),
    ).toEqual({
      orgId: workspace.orgId,
      teamId: workspace.teamId,
      revokedAt: expect.any(Date),
    });
  });
});
