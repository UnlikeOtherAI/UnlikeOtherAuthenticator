import { createHash, randomUUID } from 'node:crypto';

import { BillingAppKeyPurpose } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { validateConfigFields, type ClientConfig } from '../../src/services/config.service.js';
import { hashRefreshToken } from '../../src/services/refresh-token-replay.service.js';
import { issueRefreshToken } from '../../src/services/refresh-token.service.js';
import { exchangeRefreshTokenForTokens } from '../../src/services/token.service.js';
import { exchangeWorkspaceSwitchForTokens } from '../../src/services/workspace-switch-token.service.js';
import { createClientId } from '../../src/utils/hash.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const sharedSecret = 'test-shared-secret-with-enough-length';
const productDomain = 'api.switch-grant.example';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function expectStillPending(promise: Promise<unknown>): Promise<void> {
  const state = await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
  ]);
  expect(state).toBe('pending');
}
function config(): ClientConfig {
  return validateConfigFields(
    baseClientConfigPayload({
      domain: productDomain,
      redirect_urls: [`https://${productDomain}/oauth/callback`],
      '2fa_enabled': true,
      login_flow: { email_code_enabled: false, workspace_selection: 'off' },
      org_features: { enabled: false },
    }),
  );
}

describe.skipIf(!hasDatabase)('workspace-switch token grant', () => {
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
    process.env.SHARED_SECRET = sharedSecret;
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
    await handle.prisma.refreshToken.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.billingAppKey.deleteMany();
    await handle.prisma.billingService.deleteMany();
    await handle.prisma.clientDomain.deleteMany();
    await handle.prisma.teamMember.deleteMany();
    await handle.prisma.orgMember.deleteMany();
    await handle.prisma.team.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  async function seed() {
    const user = await handle.prisma.user.create({
      data: { email: `member-${randomUUID()}@example.com`, userKey: randomUUID() },
      select: { id: true },
    });
    const owner = await handle.prisma.user.create({
      data: { email: `owner-${randomUUID()}@example.com`, userKey: randomUUID() },
      select: { id: true },
    });
    const clientDomain = await handle.prisma.clientDomain.create({
      data: { domain: productDomain, label: productDomain, status: 'active' },
      select: { id: true },
    });
    const service = await handle.prisma.billingService.create({
      data: { identifier: `switch-${randomUUID()}`, name: 'Switch product' },
      select: { id: true },
    });
    await handle.prisma.billingAppKey.create({
      data: {
        serviceId: service.id,
        purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
        name: 'Lifecycle',
        keyPrefix: `test_${randomUUID().slice(0, 8)}`,
        secretDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        actorIssuer: `https://${productDomain}`,
        actorAudience: 'https://authentication.example/billing/v1/customer-statement',
        actorKeyId: 'test-key',
        actorPublicJwk: {},
        checkoutReturnOrigins: [`https://${productDomain}`],
      },
    });

    const workspaces = [];
    for (const label of ['source', 'target', 'other']) {
      const org = await handle.prisma.organisation.create({
        data: {
          domain: `${label}.workspace.example`,
          name: label,
          slug: `${label}-${randomUUID()}`,
          ownerId: owner.id,
        },
        select: { id: true },
      });
      const team = await handle.prisma.team.create({
        data: { orgId: org.id, name: label, slug: `${label}-${randomUUID()}`, isDefault: true },
        select: { id: true },
      });
      await handle.prisma.orgMember.createMany({
        data: [
          { orgId: org.id, userId: owner.id, role: 'owner' },
          { orgId: org.id, userId: user.id, role: 'member' },
        ],
      });
      await handle.prisma.teamMember.createMany({
        data: [
          { teamId: team.id, userId: owner.id, teamRole: 'owner' },
          { teamId: team.id, userId: user.id, teamRole: 'member' },
        ],
      });
      workspaces.push({ orgId: org.id, teamId: team.id });
    }

    const clientId = createClientId(productDomain, sharedSecret);
    const configUrl = `https://${productDomain}/auth-config`;
    const refresh = await issueRefreshToken(
      {
        userId: user.id,
        domain: productDomain,
        clientId,
        configUrl,
        ...workspaces[0]!,
        twoFaCompleted: false,
      },
      { prisma: handle.prisma, refreshTokenTtlSeconds: 3600, sharedSecret },
    );
    return { user, clientDomain, workspaces, clientId, configUrl, refresh };
  }

  function switchWorkspace(
    seeded: Awaited<ReturnType<typeof seed>>,
    target: { orgId: string; teamId: string },
    options?: {
      afterRefreshSessionLock?: () => Promise<void>;
      failTokenPair?: boolean;
      refreshToken?: string;
    },
  ) {
    return exchangeWorkspaceSwitchForTokens(
      {
        authenticatedClientDomainId: seeded.clientDomain.id,
        clientId: seeded.clientId,
        config: config(),
        configUrl: seeded.configUrl,
        organizationId: target.orgId,
        refreshToken: options?.refreshToken ?? seeded.refresh.refreshToken,
        teamId: target.teamId,
      },
      {
        adminPrisma: handle.prisma,
        prisma: handle.prisma,
        sharedSecret,
        afterRefreshSessionLock: options?.afterRefreshSessionLock,
        issueTokenPairForUser: options?.failTokenPair
          ? async () => {
              throw new Error('forced token-pair failure');
            }
          : undefined,
      },
    );
  }

  function refreshWorkspace(
    seeded: Awaited<ReturnType<typeof seed>>,
    refreshToken: string,
    afterRefreshSessionLock?: () => Promise<void>,
  ) {
    return exchangeRefreshTokenForTokens(
      {
        authenticatedClientDomainId: seeded.clientDomain.id,
        clientId: seeded.clientId,
        config: config(),
        configUrl: seeded.configUrl,
        refreshToken,
      },
      {
        adminPrisma: handle.prisma,
        prisma: handle.prisma,
        sharedSecret,
        afterRefreshSessionLock,
      },
    );
  }

  it('switches to the exact target and ordinary refresh preserves that scope', async () => {
    const seeded = await seed();
    const target = seeded.workspaces[1]!;
    const switched = await switchWorkspace(seeded, target);
    const claims = JSON.parse(
      Buffer.from(switched.accessToken.split('.')[1]!, 'base64url').toString('utf8'),
    ) as { active?: { orgId: string; teamId: string } };
    expect(claims.active).toMatchObject(target);

    await refreshWorkspace(seeded, switched.refreshToken);
    const rows = await handle.prisma.refreshToken.findMany({
      where: { userId: seeded.user.id },
      orderBy: { createdAt: 'asc' },
      select: { orgId: true, teamId: true, twoFaCompleted: true },
    });
    expect(rows).toHaveLength(3);
    expect(rows.slice(1)).toEqual([
      { ...target, twoFaCompleted: false },
      { ...target, twoFaCompleted: false },
    ]);
  });

  it('rolls rotation back when access-token issuance fails', async () => {
    const seeded = await seed();
    await expect(
      switchWorkspace(seeded, seeded.workspaces[1]!, { failTokenPair: true }),
    ).rejects.toThrow('forced token-pair failure');
    expect(
      await handle.prisma.refreshToken.findUniqueOrThrow({
        where: { id: seeded.refresh.refreshTokenId },
        select: { replacedByTokenId: true, revokedAt: true },
      }),
    ).toEqual({ replacedByTokenId: null, revokedAt: null });
    expect(await handle.prisma.refreshToken.count({ where: { userId: seeded.user.id } })).toBe(1);
  });

  it('leaves the source live for unavailable targets and insufficient assurance', async () => {
    const seeded = await seed();
    const [source, target] = seeded.workspaces as [
      { orgId: string; teamId: string },
      { orgId: string; teamId: string },
    ];
    const attempt = (organizationId: string, teamId: string) =>
      exchangeWorkspaceSwitchForTokens(
        {
          authenticatedClientDomainId: seeded.clientDomain.id,
          clientId: seeded.clientId,
          config: config(),
          configUrl: seeded.configUrl,
          organizationId,
          refreshToken: seeded.refresh.refreshToken,
          teamId,
        },
        { adminPrisma: handle.prisma, prisma: handle.prisma, sharedSecret },
      );

    await expect(attempt(target.orgId, source.teamId)).rejects.toMatchObject({
      statusCode: 403,
      message: 'WORKSPACE_NOT_AVAILABLE',
    });
    await handle.prisma.organisation.update({
      where: { id: target.orgId },
      data: { twoFaPolicy: 'REQUIRED' },
    });
    await expect(attempt(target.orgId, target.teamId)).rejects.toMatchObject({
      statusCode: 403,
      message: 'INTERACTION_REQUIRED',
    });
    expect(
      await handle.prisma.refreshToken.findUniqueOrThrow({
        where: { id: seeded.refresh.refreshTokenId },
        select: { revokedAt: true, replacedByTokenId: true },
      }),
    ).toEqual({ revokedAt: null, replacedByTokenId: null });
    expect(await handle.prisma.refreshToken.count({ where: { userId: seeded.user.id } })).toBe(1);
  });

  it.each(['membership', 'twofa'] as const)(
    'retires only the committed family when replay target %s policy is lost',
    async (loss) => {
      const seeded = await seed();
      const target = seeded.workspaces[1]!;
      const switched = await switchWorkspace(seeded, target);
      const sibling = await issueRefreshToken(
        {
          userId: seeded.user.id,
          domain: productDomain,
          clientId: seeded.clientId,
          configUrl: seeded.configUrl,
          ...seeded.workspaces[0]!,
          twoFaCompleted: false,
        },
        { prisma: handle.prisma, refreshTokenTtlSeconds: 3600, sharedSecret },
      );

      if (loss === 'membership') {
        await handle.prisma.teamMember.update({
          where: { teamId_userId: { teamId: target.teamId, userId: seeded.user.id } },
          data: { status: 'DEACTIVATED', statusChangedAt: new Date() },
        });
      } else {
        await handle.prisma.organisation.update({
          where: { id: target.orgId },
          data: { twoFaPolicy: 'REQUIRED' },
        });
      }

      for (let retry = 0; retry < 2; retry += 1) {
        await expect(switchWorkspace(seeded, target)).rejects.toMatchObject({
          statusCode: 401,
          message: 'INVALID_REFRESH_TOKEN',
        });
      }
      expect(
        await handle.prisma.refreshToken.findUniqueOrThrow({
          where: { tokenHash: hashRefreshToken(switched.refreshToken, sharedSecret) },
          select: { revokedAt: true },
        }),
      ).toEqual({ revokedAt: expect.any(Date) });
      expect(
        await handle.prisma.refreshToken.findUniqueOrThrow({
          where: { id: sibling.refreshTokenId },
          select: { revokedAt: true },
        }),
      ).toEqual({ revokedAt: null });
      expect(
        await handle.prisma.user.findUniqueOrThrow({
          where: { id: seeded.user.id },
          select: { tokenVersion: true },
        }),
      ).toEqual({ tokenVersion: 0 });
    },
  );

  it('converges identical concurrent switch attempts on one target token', async () => {
    const seeded = await seed();
    const target = seeded.workspaces[1]!;
    const locked = deferred();
    const release = deferred();
    const firstRequest = switchWorkspace(seeded, target, {
      afterRefreshSessionLock: async () => {
        locked.resolve();
        await release.promise;
      },
    });
    await locked.promise;
    const secondRequest = switchWorkspace(seeded, target);
    await expectStillPending(secondRequest);
    release.resolve();
    const [first, second] = await Promise.all([firstRequest, secondRequest]);

    expect(second.refreshToken).toBe(first.refreshToken);
    expect(
      await handle.prisma.refreshToken.findMany({
        where: { userId: seeded.user.id },
        orderBy: { createdAt: 'asc' },
        select: { orgId: true, revokedAt: true, teamId: true },
      }),
    ).toEqual([
      {
        orgId: seeded.workspaces[0]!.orgId,
        revokedAt: expect.any(Date),
        teamId: seeded.workspaces[0]!.teamId,
      },
      { orgId: target.orgId, revokedAt: null, teamId: target.teamId },
    ]);
  });

  it('lets only one competing target win without revoking the family', async () => {
    const seeded = await seed();
    const locked = deferred();
    const release = deferred();
    const firstRequest = switchWorkspace(seeded, seeded.workspaces[1]!, {
      afterRefreshSessionLock: async () => {
        locked.resolve();
        await release.promise;
      },
    });
    await locked.promise;
    const secondRequest = switchWorkspace(seeded, seeded.workspaces[2]!);
    await expectStillPending(secondRequest);
    release.resolve();
    const results = await Promise.allSettled([firstRequest, secondRequest]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { statusCode: 409, message: 'WORKSPACE_SWITCH_CONFLICT' },
    });
    const rows = await handle.prisma.refreshToken.findMany({
      where: { userId: seeded.user.id },
      orderBy: { createdAt: 'asc' },
      select: { orgId: true, revokedAt: true, teamId: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]!.revokedAt).toBeNull();
    expect([seeded.workspaces[1], seeded.workspaces[2]]).toContainEqual({
      orgId: rows[1]!.orgId,
      teamId: rows[1]!.teamId,
    });
    expect(
      await handle.prisma.user.findUniqueOrThrow({
        where: { id: seeded.user.id },
        select: { tokenVersion: true },
      }),
    ).toEqual({ tokenVersion: 0 });
  });

  it.each(['refresh', 'switch'] as const)(
    'keeps ordinary refresh and switch scope-stable when %s wins the lock',
    async (firstKind) => {
      const seeded = await seed();
      const target = seeded.workspaces[1]!;
      const locked = deferred();
      const release = deferred();
      const afterLock = async () => {
        locked.resolve();
        await release.promise;
      };
      const firstRequest =
        firstKind === 'refresh'
          ? refreshWorkspace(seeded, seeded.refresh.refreshToken, afterLock)
          : switchWorkspace(seeded, target, { afterRefreshSessionLock: afterLock });
      await locked.promise;
      const secondRequest =
        firstKind === 'refresh'
          ? switchWorkspace(seeded, target)
          : refreshWorkspace(seeded, seeded.refresh.refreshToken);
      await expectStillPending(secondRequest);
      release.resolve();
      const results = await Promise.allSettled([firstRequest, secondRequest]);

      expect(results[0]!.status).toBe('fulfilled');
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: { message: 'WORKSPACE_SWITCH_CONFLICT', statusCode: 409 },
      });
      const rows = await handle.prisma.refreshToken.findMany({
        where: { userId: seeded.user.id },
        orderBy: { createdAt: 'asc' },
        select: { orgId: true, revokedAt: true, teamId: true },
      });
      expect(rows).toHaveLength(2);
      expect(rows[1]!.revokedAt).toBeNull();
      expect(firstKind === 'refresh' ? seeded.workspaces[0] : target).toEqual({
        orgId: rows[1]!.orgId,
        teamId: rows[1]!.teamId,
      });
    },
  );

  it('replays only through descendants that retain the requested target', async () => {
    const seeded = await seed();
    const target = seeded.workspaces[1]!;
    const switched = await switchWorkspace(seeded, target);
    const replay = await switchWorkspace(seeded, target);
    expect(replay.refreshToken).toBe(switched.refreshToken);

    const refreshed = await refreshWorkspace(seeded, switched.refreshToken);
    const multiHopReplay = await switchWorkspace(seeded, target);
    expect(multiHopReplay.refreshToken).toBe(refreshed.refreshToken);

    const other = seeded.workspaces[2]!;
    const switchedAgain = await switchWorkspace(seeded, other, {
      refreshToken: refreshed.refreshToken,
    });
    await expect(switchWorkspace(seeded, target)).rejects.toMatchObject({
      message: 'WORKSPACE_SWITCH_CONFLICT',
      statusCode: 409,
    });
    const live = await handle.prisma.refreshToken.findFirstOrThrow({
      where: { userId: seeded.user.id, revokedAt: null },
      select: { orgId: true, teamId: true, tokenHash: true },
    });
    expect(live).toMatchObject(other);
    expect(switchedAgain.refreshToken).not.toBe(refreshed.refreshToken);
  });
});
