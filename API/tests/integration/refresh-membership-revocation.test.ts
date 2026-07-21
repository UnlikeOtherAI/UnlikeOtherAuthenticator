import { createHash, randomUUID } from 'node:crypto';

import { BillingAppKeyPurpose } from '@prisma/client';
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
import {
  exchangeRefreshToken,
  issueRefreshToken,
} from '../../src/services/refresh-token.service.js';
import { addTeamMember, removeTeamMember } from '../../src/services/team.service.members.js';
import { exchangeRefreshTokenForTokens } from '../../src/services/token.service.js';
import { createClientId } from '../../src/utils/hash.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const workspaceDomain = 'workspace.refresh-revocation.example';
const productDomains = [
  'api.nessie.refresh-revocation.example',
  'api.deepwater.refresh-revocation.example',
  'api.deepsignal.refresh-revocation.example',
  'api.deeptest.refresh-revocation.example',
] as const;
const sharedSecret = 'test-shared-secret-with-enough-length';

type Workspace = {
  ownerId: string;
  userId: string;
  orgId: string;
  teamId: string;
  otherOrgId: string;
  otherOrgTeamId: string;
  otherTeamId: string;
};

type IssuedRefresh = Awaited<ReturnType<typeof issueRefreshToken>> & {
  clientId: string;
  configUrl: string;
  domain: string;
};

function config(domain: string): ClientConfig {
  return validateConfigFields(
    baseClientConfigPayload({
      domain,
      redirect_urls: [`https://${domain}/oauth/callback`],
      login_flow: { email_code_enabled: false, workspace_selection: 'off' },
      org_features: { enabled: false },
    }),
  );
}

function workspaceConfig(): ClientConfig {
  return validateConfigFields(
    baseClientConfigPayload({
      domain: workspaceDomain,
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

describe.skipIf(!hasDatabase)('workspace refresh-family revocation', () => {
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
    await handle.prisma.adminAuditLog.deleteMany();
    await handle.prisma.orgAuditLog.deleteMany();
    await handle.prisma.refreshToken.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.billingAppKey.deleteMany();
    await handle.prisma.billingService.deleteMany();
    await handle.prisma.clientDomain.deleteMany();
    await handle.prisma.groupMember.deleteMany();
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
        domain: workspaceDomain,
        name: 'Target workspace',
        slug: `target-${randomUUID()}`,
        ownerId: owner.id,
      },
      select: { id: true },
    });
    const otherOrg = await handle.prisma.organisation.create({
      data: {
        domain: 'other.refresh-revocation.example',
        name: 'Other workspace',
        slug: `other-${randomUUID()}`,
        ownerId: owner.id,
      },
      select: { id: true },
    });
    await handle.prisma.orgMember.createMany({
      data: [
        { orgId: org.id, userId: owner.id, role: 'owner' },
        { orgId: org.id, userId: user.id, role: 'member' },
        { orgId: otherOrg.id, userId: owner.id, role: 'owner' },
        { orgId: otherOrg.id, userId: user.id, role: 'member' },
      ],
    });
    const team = await handle.prisma.team.create({
      data: {
        orgId: org.id,
        name: 'Target team',
        slug: `target-team-${randomUUID()}`,
        isDefault: true,
      },
      select: { id: true },
    });
    const otherTeam = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Other team', slug: `other-team-${randomUUID()}` },
      select: { id: true },
    });
    const otherOrgTeam = await handle.prisma.team.create({
      data: {
        orgId: otherOrg.id,
        name: 'Other org team',
        slug: `other-org-team-${randomUUID()}`,
        isDefault: true,
      },
      select: { id: true },
    });
    await handle.prisma.teamMember.createMany({
      data: [
        { teamId: team.id, userId: owner.id, teamRole: 'owner' },
        { teamId: team.id, userId: user.id, teamRole: 'member' },
        { teamId: otherTeam.id, userId: owner.id, teamRole: 'owner' },
        { teamId: otherTeam.id, userId: user.id, teamRole: 'member' },
        { teamId: otherOrgTeam.id, userId: owner.id, teamRole: 'owner' },
        { teamId: otherOrgTeam.id, userId: user.id, teamRole: 'member' },
      ],
    });
    return {
      ownerId: owner.id,
      userId: user.id,
      orgId: org.id,
      teamId: team.id,
      otherOrgId: otherOrg.id,
      otherOrgTeamId: otherOrgTeam.id,
      otherTeamId: otherTeam.id,
    };
  }

  async function issue(
    userId: string,
    domain: string,
    orgId: string | null,
    teamId: string | null,
    label = randomUUID(),
  ): Promise<IssuedRefresh> {
    const clientId = createClientId(domain, sharedSecret);
    const configUrl = `https://${domain}/auth-config/${label}`;
    const token = await issueRefreshToken(
      { userId, domain, clientId, configUrl, orgId, teamId },
      { prisma: handle.prisma, refreshTokenTtlSeconds: 3600, sharedSecret },
    );
    return { ...token, clientId, configUrl, domain };
  }

  function rotateRaw(token: IssuedRefresh) {
    return exchangeRefreshToken(
      {
        refreshToken: token.refreshToken,
        domain: token.domain,
        clientId: token.clientId,
        configUrl: token.configUrl,
      },
      { prisma: handle.prisma, sharedSecret },
    );
  }

  async function registerProduct(domain: string): Promise<string> {
    const clientDomain = await handle.prisma.clientDomain.create({
      data: { domain, label: domain, status: 'active' },
      select: { id: true },
    });
    const service = await handle.prisma.billingService.create({
      data: { identifier: `product-${randomUUID()}`, name: domain },
      select: { id: true },
    });
    await handle.prisma.billingAppKey.create({
      data: {
        serviceId: service.id,
        purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
        name: 'Lifecycle',
        keyPrefix: `test_${randomUUID().slice(0, 8)}`,
        secretDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        actorIssuer: `https://${domain}`,
        actorAudience: 'https://authentication.example/billing/v1/customer-statement',
        actorKeyId: 'test-key',
        actorPublicJwk: {},
        checkoutReturnOrigins: [`https://${domain}`],
      },
    });
    return clientDomain.id;
  }

  function refreshProduct(
    token: IssuedRefresh,
    clientDomainId: string,
    afterActiveWorkspaceLock?: () => Promise<void>,
  ) {
    return exchangeRefreshTokenForTokens(
      {
        authenticatedClientDomainId: clientDomainId,
        clientId: token.clientId,
        config: config(token.domain),
        configUrl: token.configUrl,
        refreshToken: token.refreshToken,
      },
      {
        adminPrisma: handle.prisma,
        prisma: handle.prisma,
        sharedSecret,
        afterActiveWorkspaceLock,
      },
    );
  }

  async function expectStillPending(promise: Promise<unknown>): Promise<void> {
    const result = await Promise.race([
      promise.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 40)),
    ]);
    expect(result).toBe('pending');
  }

  it('deactivation revokes exact-org families across every product plus legacy same-domain state', async () => {
    const workspace = await seedWorkspace();
    const productTokens = await Promise.all(
      productDomains.map((domain) => issue(workspace.userId, domain, workspace.orgId, workspace.teamId)),
    );
    const legacy = await issue(workspace.userId, workspaceDomain, null, null, 'legacy');
    const unrelated = await issue(
      workspace.userId,
      productDomains[0],
      workspace.otherOrgId,
      workspace.otherOrgTeamId,
      'unrelated',
    );

    await deactivateOrganisationMember(
      {
        orgId: workspace.orgId,
        domain: workspaceDomain,
        actorUserId: workspace.ownerId,
        userId: workspace.userId,
      },
      { prisma: handle.prisma },
    );
    const revoked = await handle.prisma.refreshToken.findMany({
      where: { id: { in: [...productTokens.map((token) => token.refreshTokenId), legacy.refreshTokenId] } },
      select: { revokedAt: true },
    });
    expect(revoked.every((row) => row.revokedAt !== null)).toBe(true);
    expect(
      await handle.prisma.refreshToken.findUniqueOrThrow({
        where: { id: unrelated.refreshTokenId },
        select: { revokedAt: true },
      }),
    ).toEqual({ revokedAt: null });

    await reactivateOrganisationMember(
      {
        orgId: workspace.orgId,
        domain: workspaceDomain,
        actorUserId: workspace.ownerId,
        userId: workspace.userId,
      },
      { prisma: handle.prisma },
    );
    await expect(rotateRaw(productTokens[0])).rejects.toMatchObject({ statusCode: 401 });
    await expect(rotateRaw(unrelated)).resolves.toMatchObject({ refreshToken: expect.any(String) });
  });

  it('org removal remains revoked after the member is re-added', async () => {
    const workspace = await seedWorkspace();
    const token = await issue(
      workspace.userId,
      productDomains[1],
      workspace.orgId,
      workspace.teamId,
    );
    await removeOrganisationMember(
      {
        orgId: workspace.orgId,
        domain: workspaceDomain,
        actorUserId: workspace.ownerId,
        userId: workspace.userId,
      },
      { prisma: handle.prisma },
    );
    await addOrganisationMember(
      {
        orgId: workspace.orgId,
        domain: workspaceDomain,
        actorUserId: workspace.ownerId,
        userId: workspace.userId,
        role: 'member',
        config: workspaceConfig(),
      },
      { prisma: handle.prisma },
    );
    await expect(rotateRaw(token)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('team removal revokes only exact-team families across all product domains and re-add stays dead', async () => {
    const workspace = await seedWorkspace();
    const targetTokens = await Promise.all(
      productDomains.map((domain) => issue(workspace.userId, domain, workspace.orgId, workspace.teamId)),
    );
    const otherTeam = await issue(
      workspace.userId,
      productDomains[0],
      workspace.orgId,
      workspace.otherTeamId,
      'other-team',
    );
    const legacy = await issue(workspace.userId, workspaceDomain, null, null, 'legacy-team');

    await removeTeamMember(
      {
        orgId: workspace.orgId,
        teamId: workspace.teamId,
        domain: workspaceDomain,
        actorUserId: workspace.ownerId,
        userId: workspace.userId,
      },
      { prisma: handle.prisma },
    );
    const targetRows = await handle.prisma.refreshToken.findMany({
      where: { id: { in: targetTokens.map((token) => token.refreshTokenId) } },
      select: { revokedAt: true },
    });
    expect(targetRows.every((row) => row.revokedAt !== null)).toBe(true);
    for (const id of [otherTeam.refreshTokenId, legacy.refreshTokenId]) {
      expect(
        await handle.prisma.refreshToken.findUniqueOrThrow({
          where: { id },
          select: { revokedAt: true },
        }),
      ).toEqual({ revokedAt: null });
    }

    await addTeamMember(
      {
        orgId: workspace.orgId,
        teamId: workspace.teamId,
        domain: workspaceDomain,
        actorUserId: workspace.ownerId,
        userId: workspace.userId,
        config: workspaceConfig(),
      },
      { prisma: handle.prisma },
    );
    await expect(rotateRaw(targetTokens[0])).rejects.toMatchObject({ statusCode: 401 });
    await expect(rotateRaw(otherTeam)).resolves.toMatchObject({ refreshToken: expect.any(String) });
  });

  it('refresh-first serializes before team removal, which then revokes the replacement', async () => {
    const workspace = await seedWorkspace();
    const domain = productDomains[2];
    const clientDomainId = await registerProduct(domain);
    const token = await issue(workspace.userId, domain, workspace.orgId, workspace.teamId);
    const locked = deferred();
    const release = deferred();
    const rotation = refreshProduct(token, clientDomainId, async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const removal = removeTeamMember(
      {
        orgId: workspace.orgId,
        teamId: workspace.teamId,
        domain: workspaceDomain,
        actorUserId: workspace.ownerId,
        userId: workspace.userId,
      },
      { prisma: handle.prisma },
    );
    await expectStillPending(removal);
    release.resolve();

    const rotated = await rotation;
    await expect(removal).resolves.toEqual({ removed: true });
    const rows = await handle.prisma.refreshToken.findMany({
      where: { userId: workspace.userId, teamId: workspace.teamId },
      select: { revokedAt: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    expect(rotated.refreshToken).not.toBe(token.refreshToken);
  });

  it('removal-first makes the waiting refresh fail without creating a replacement', async () => {
    const workspace = await seedWorkspace();
    const domain = productDomains[3];
    const clientDomainId = await registerProduct(domain);
    const token = await issue(workspace.userId, domain, workspace.orgId, workspace.teamId);
    const statusWritten = deferred();
    const release = deferred();
    const removal = removeTeamMember(
      {
        orgId: workspace.orgId,
        teamId: workspace.teamId,
        domain: workspaceDomain,
        actorUserId: workspace.ownerId,
        userId: workspace.userId,
      },
      {
        prisma: handle.prisma,
        afterMembershipStatusWrite: async () => {
          statusWritten.resolve();
          await release.promise;
        },
      },
    );
    await statusWritten.promise;

    const rotation = refreshProduct(token, clientDomainId);
    await expectStillPending(rotation);
    release.resolve();

    await expect(removal).resolves.toEqual({ removed: true });
    await expect(rotation).rejects.toMatchObject({ statusCode: 401 });
    expect(
      await handle.prisma.refreshToken.count({
        where: { userId: workspace.userId, teamId: workspace.teamId },
      }),
    ).toBe(1);
  });
});
