import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { validateConfigFields, type ClientConfig } from '../../src/services/config.service.js';
import {
  addOrganisationMember,
  removeOrganisationMember,
} from '../../src/services/organisation.service.members.js';
import {
  deactivateOrganisationMember,
  reactivateOrganisationMember,
} from '../../src/services/organisation.service.lifecycle.js';
import { issueRefreshToken } from '../../src/services/refresh-token.service.js';
import { exchangeRefreshTokenForTokens } from '../../src/services/token.service.js';
import { createClientId } from '../../src/utils/hash.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const domain = 'legacy-session-race.example';
const sharedSecret = 'test-shared-secret-with-enough-length';

type Workspace = {
  ownerId: string;
  userId: string;
  orgId: string;
  teamId: string;
};

type LegacyRefresh = Awaited<ReturnType<typeof issueRefreshToken>> & {
  clientId: string;
  configUrl: string;
  domain: string;
};

function legacyConfig(): ClientConfig {
  return validateConfigFields(
    baseClientConfigPayload({
      domain,
      redirect_urls: [`https://${domain}/oauth/callback`],
      login_flow: { email_code_enabled: false, workspace_selection: 'off' },
      org_features: { enabled: true, user_needs_team: false },
    }),
  );
}

function membershipConfig(): ClientConfig {
  return validateConfigFields(
    baseClientConfigPayload({
      domain,
      org_features: { enabled: true, user_needs_team: true },
    }),
  );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!hasDatabase)('refresh session serialization and reuse revocation', () => {
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
    process.env.SHARED_SECRET = sharedSecret;
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
    await handle.prisma.orgAuditLog.deleteMany();
    await handle.prisma.refreshToken.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.teamMember.deleteMany();
    await handle.prisma.orgMember.deleteMany();
    await handle.prisma.team.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  async function seedWorkspace(): Promise<Workspace> {
    const owner = await handle.prisma.user.create({
      data: { email: `owner-${randomUUID()}@example.com`, userKey: randomUUID() },
      select: { id: true },
    });
    const user = await handle.prisma.user.create({
      data: { email: `member-${randomUUID()}@example.com`, userKey: randomUUID() },
      select: { id: true },
    });
    const org = await handle.prisma.organisation.create({
      data: {
        domain,
        name: 'Legacy session workspace',
        slug: `legacy-${randomUUID()}`,
        ownerId: owner.id,
      },
      select: { id: true },
    });
    await handle.prisma.orgMember.createMany({
      data: [
        { orgId: org.id, userId: owner.id, role: 'owner' },
        { orgId: org.id, userId: user.id, role: 'member' },
      ],
    });
    const team = await handle.prisma.team.create({
      data: {
        orgId: org.id,
        name: 'General',
        slug: `general-${randomUUID()}`,
        isDefault: true,
      },
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

  async function issueLegacy(userId: string, label = randomUUID()): Promise<LegacyRefresh> {
    const clientId = createClientId(domain, sharedSecret);
    const configUrl = `https://${domain}/auth-config/${label}`;
    const token = await issueRefreshToken(
      { userId, domain, clientId, configUrl, orgId: null, teamId: null },
      { prisma: handle.prisma, refreshTokenTtlSeconds: 3600, sharedSecret },
    );
    return { ...token, clientId, configUrl, domain };
  }

  function withRefreshValue(token: LegacyRefresh, refreshToken: string): LegacyRefresh {
    return { ...token, refreshToken };
  }

  function refreshLegacy(
    token: LegacyRefresh,
    hooks?: { afterRefreshSessionLock?: () => Promise<void> },
  ) {
    return exchangeRefreshTokenForTokens(
      {
        clientId: token.clientId,
        config: legacyConfig(),
        configUrl: token.configUrl,
        refreshToken: token.refreshToken,
      },
      {
        adminPrisma: handle.prisma,
        prisma: handle.prisma,
        sharedSecret,
        afterRefreshSessionLock: hooks?.afterRefreshSessionLock,
      },
    );
  }

  async function expectStillPending(promise: Promise<unknown>): Promise<void> {
    const state = await Promise.race([
      promise.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 40)),
    ]);
    expect(state).toBe('pending');
  }

  async function expectAllRevoked(userId: string, expectedCount: number): Promise<void> {
    const rows = await handle.prisma.refreshToken.findMany({
      where: { userId, domain },
      select: { revokedAt: true },
    });
    expect(rows).toHaveLength(expectedCount);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  }

  it('refresh-first lets deactivation revoke the legacy replacement permanently', async () => {
    const workspace = await seedWorkspace();
    const original = await issueLegacy(workspace.userId);
    const locked = deferred();
    const release = deferred();
    const rotation = refreshLegacy(original, {
      afterRefreshSessionLock: async () => {
        locked.resolve();
        await release.promise;
      },
    });
    await locked.promise;

    const deactivation = deactivateOrganisationMember(
      { ...workspace, domain, actorUserId: workspace.ownerId },
      { prisma: handle.prisma },
    );
    await expectStillPending(deactivation);
    release.resolve();

    const replacement = await rotation;
    await expect(deactivation).resolves.toEqual({ deactivated: true });
    await expectAllRevoked(workspace.userId, 2);

    await reactivateOrganisationMember(
      { ...workspace, domain, actorUserId: workspace.ownerId },
      { prisma: handle.prisma },
    );
    await expect(
      refreshLegacy(withRefreshValue(original, replacement.refreshToken)),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('removal-first blocks legacy rotation and re-add cannot revive the family', async () => {
    const workspace = await seedWorkspace();
    const original = await issueLegacy(workspace.userId);
    const statusWritten = deferred();
    const release = deferred();
    const removal = removeOrganisationMember(
      { ...workspace, domain, actorUserId: workspace.ownerId },
      {
        prisma: handle.prisma,
        afterMembershipStatusWrite: async () => {
          statusWritten.resolve();
          await release.promise;
        },
      },
    );
    await statusWritten.promise;

    const rotation = refreshLegacy(original);
    await expectStillPending(rotation);
    release.resolve();

    await expect(removal).resolves.toEqual({ removed: true });
    await expect(rotation).rejects.toMatchObject({ statusCode: 401 });
    await expectAllRevoked(workspace.userId, 1);

    await addOrganisationMember(
      {
        orgId: workspace.orgId,
        domain,
        actorUserId: workspace.ownerId,
        userId: workspace.userId,
        role: 'member',
        config: membershipConfig(),
      },
      { prisma: handle.prisma },
    );
    await expect(refreshLegacy(original)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('commits family revocation before rejecting reuse and keeps the replacement dead', async () => {
    const workspace = await seedWorkspace();
    const original = await issueLegacy(workspace.userId);
    const rotated = await refreshLegacy(original);
    const current = withRefreshValue(original, rotated.refreshToken);

    await expect(refreshLegacy(original)).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_REFRESH_TOKEN',
    });
    await expectAllRevoked(workspace.userId, 2);
    await expect(refreshLegacy(current)).rejects.toMatchObject({ statusCode: 401 });
    await expectAllRevoked(workspace.userId, 2);
  });

  it('current rotation first is followed by reuse revoking its new replacement', async () => {
    const workspace = await seedWorkspace();
    const original = await issueLegacy(workspace.userId);
    const firstRotation = await refreshLegacy(original);
    const current = withRefreshValue(original, firstRotation.refreshToken);
    const locked = deferred();
    const release = deferred();
    const currentRotation = refreshLegacy(current, {
      afterRefreshSessionLock: async () => {
        locked.resolve();
        await release.promise;
      },
    });
    await locked.promise;

    const reuse = refreshLegacy(original);
    await expectStillPending(reuse);
    release.resolve();

    const newest = await currentRotation;
    await expect(reuse).rejects.toMatchObject({ statusCode: 401 });
    await expectAllRevoked(workspace.userId, 3);
    await expect(
      refreshLegacy(withRefreshValue(original, newest.refreshToken)),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('reuse first revokes the current token before its waiting rotation can replace it', async () => {
    const workspace = await seedWorkspace();
    const original = await issueLegacy(workspace.userId);
    const firstRotation = await refreshLegacy(original);
    const current = withRefreshValue(original, firstRotation.refreshToken);
    const locked = deferred();
    const release = deferred();
    const reuse = refreshLegacy(original, {
      afterRefreshSessionLock: async () => {
        locked.resolve();
        await release.promise;
      },
    });
    await locked.promise;

    const currentRotation = refreshLegacy(current);
    await expectStillPending(currentRotation);
    release.resolve();

    await expect(reuse).rejects.toMatchObject({ statusCode: 401 });
    await expect(currentRotation).rejects.toMatchObject({ statusCode: 401 });
    await expectAllRevoked(workspace.userId, 2);
  });
});
