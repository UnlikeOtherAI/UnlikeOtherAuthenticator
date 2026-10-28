import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { AppError } from '../../src/utils/errors.js';

const isPlatformSuperuserMock = vi.hoisted(() => vi.fn());
const claimsMock = vi.hoisted(() => vi.fn());
const getActiveClientOrgContextMock = vi.hoisted(() => vi.fn());
const getUserOrgContextMock = vi.hoisted(() => vi.fn());
const buildSidebarPendingInvitesMock = vi.hoisted(() => vi.fn());
const buildSidebarTeamsMock = vi.hoisted(() => vi.fn());
const resolveProductTeamPolicyMock = vi.hoisted(() => vi.fn());
const authorityMock = vi.hoisted(() => vi.fn());
const assuranceMock = vi.hoisted(() => vi.fn());
const adminReadMock = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => ({ transaction: true, user: { findUniqueOrThrow: vi.fn() } }));

const config = {
  domain: 'product.example.com',
  org_features: { enabled: true, groups_enabled: false },
} as ClientConfig;

vi.mock('../../src/middleware/domain-hash-auth.js', () => ({
  requireDomainHashAuthForDomainQuery: async () => undefined,
}));

vi.mock('../../src/middleware/config-verifier.js', () => ({
  configVerifier: async (request: { config?: ClientConfig }): Promise<void> => {
    request.config = config;
  },
}));

vi.mock('../../src/middleware/org-features.js', () => ({
  requireOrgFeaturesEnabled: async () => undefined,
}));

vi.mock('../../src/middleware/org-role-guard.js', () => ({
  resolveOrgUserClaims: (...args: unknown[]) => claimsMock(...args),
}));

vi.mock('../../src/plugins/tenant-context.plugin.js', () => ({
  setTenantContextFromRequest: (request: { tenantContext?: unknown }) => {
    request.tenantContext = { domain: config.domain, userId: 'user-1' };
  },
  runWithRequestAdminTransaction: (...args: unknown[]) => adminReadMock(...args),
}));

vi.mock('../../src/config/env.js', () => ({ getEnv: () => ({ DATABASE_URL: 'unit-fixture' }) }));
vi.mock('../../src/services/tenant-effect-authority.service.js', () => ({
  assertTenantEffectAuthority: (...args: unknown[]) => authorityMock(...args),
}));
vi.mock('../../src/services/session-assurance.service.js', () => ({
  validateSessionAssurance: (...args: unknown[]) => assuranceMock(...args),
}));

vi.mock('../../src/routes/org/domain-context.js', () => ({
  assertVerifiedDomainMatchesQuery: () => undefined,
  normalizeDomain: (value: string) => value.trim().toLowerCase(),
}));

vi.mock('../../src/services/domain-role.service.js', () => ({
  isPlatformSuperuser: (...args: unknown[]) => isPlatformSuperuserMock(...args),
}));

vi.mock('../../src/services/org-context.service.js', () => ({
  getActiveClientOrgContext: (...args: unknown[]) => getActiveClientOrgContextMock(...args),
  getUserOrgContext: (...args: unknown[]) => getUserOrgContextMock(...args),
}));

vi.mock('../../src/services/team-directory.service.js', () => ({
  buildSidebarPendingInvites: (...args: unknown[]) => buildSidebarPendingInvitesMock(...args),
  buildSidebarTeams: (...args: unknown[]) => buildSidebarTeamsMock(...args),
}));

vi.mock('../../src/services/product-team-policy.service.js', () => ({
  resolveProductTeamPolicy: (...args: unknown[]) =>
    resolveProductTeamPolicyMock(...args),
}));

async function getOrgMe() {
  const { registerOrgMeRoute } = await import('../../src/routes/org/me.js');
  const app = fastify();
  app.decorateRequest('adminDb', null);
  app.decorateRequest('tenantContext', undefined);
  app.addHook('onRequest', async (request) => {
    request.adminDb = new Proxy({}, { get: () => {
      throw new Error('A route read escaped the single authority transaction');
    } }) as never;
  });
  registerOrgMeRoute(app);
  await app.ready();
  try {
    return await app.inject({
      method: 'GET',
      url: '/org/me?domain=product.example.com&config_url=https%3A%2F%2Fproduct.example.com%2Fauth-config',
      headers: { 'x-uoa-access-token': 'Bearer selected-token' },
    });
  } finally {
    await app.close();
  }
}

describe('GET /org/me cross-product directory', () => {
  beforeEach(() => {
    for (const mock of [
      isPlatformSuperuserMock,
      claimsMock,
      getActiveClientOrgContextMock,
      getUserOrgContextMock,
      buildSidebarPendingInvitesMock,
      buildSidebarTeamsMock,
      resolveProductTeamPolicyMock,
      authorityMock, assuranceMock, adminReadMock, transaction.user.findUniqueOrThrow,
    ]) {
      mock.mockReset();
    }

    isPlatformSuperuserMock.mockResolvedValue(false);
    authorityMock.mockResolvedValue(undefined);
    assuranceMock.mockResolvedValue(undefined);
    adminReadMock.mockImplementation(async (_request, callback) => callback(transaction));
    transaction.user.findUniqueOrThrow.mockResolvedValue({ id: 'u1', name: 'Person',
      email: 'person@example.com', lifecycleStatus: 'ACTIVE' });
    claimsMock.mockResolvedValue({
      userId: 'user-1',
      tokenVersion: 0,
      domain: 'product.example.com',
      active: { orgId: 'org-cross', teamId: 'team-cross' },
    });
    getUserOrgContextMock.mockResolvedValue(null);
    getActiveClientOrgContextMock.mockResolvedValue({
      org_id: 'org-cross',
      tenant_slug: 'external-org',
      org_role: 'member',
      teams: ['team-cross'],
      team_roles: { 'team-cross': 'member' },
    });
    resolveProductTeamPolicyMock.mockResolvedValue({
      scope: 'all_active_memberships',
      serviceId: 'service-1',
      product: 'nessie',
    });
    buildSidebarTeamsMock.mockResolvedValue([
      {
        teamId: 'team-cross',
        orgId: 'org-cross',
        name: 'Cross-domain team',
        slug: 'cross-domain-team',
        orgName: 'External org',
        iconUrl: null,
        avatarImageUrl: '/teams/team-cross/avatar',
        role: 'member',
        lastLoginAt: null,
      },
    ]);
    buildSidebarPendingInvitesMock.mockResolvedValue([]);
  });

  it('uses the selected live cross-product org when no same-domain context exists', async () => {
    const response = await getOrgMe();

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toMatchObject({
      ok: true,
      system_admin: false,
      org: {
        org_id: 'org-cross',
        tenant_slug: 'external-org',
        org_role: 'member',
        teams: ['team-cross'],
        team_roles: { 'team-cross': 'member' },
        // Distinct keys: a duplicate `teams` here silently dropped the legacy
        // id-array assertion and let the directory clobber it in the route.
        team_directory: [
          expect.objectContaining({
            teamId: 'team-cross',
            orgId: 'org-cross',
            avatarImageUrl: '/teams/team-cross/avatar',
          }),
        ],
        pending_invites: [],
      },
    });
    expect(getActiveClientOrgContextMock).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        domain: 'product.example.com',
        orgId: 'org-cross',
        groupsEnabled: false,
      },
      { prisma: transaction, policyPrisma: transaction, crossProductPrisma: transaction },
    );
    expect(buildSidebarTeamsMock).toHaveBeenCalled();
  });

  it('returns orgId on sidebar pending invitations', async () => {
    buildSidebarPendingInvitesMock.mockResolvedValue([
      {
        inviteId: 'invite-1',
        orgId: 'org-invited',
        teamId: 'team-invited',
        teamName: 'Invited team',
        invitedBy: 'Alice Admin',
        expiresAt: new Date('2026-09-30T00:00:00.000Z'),
      },
    ]);

    const response = await getOrgMe();

    expect(response.statusCode).toBe(200);
    expect(response.json().org.pending_invites).toEqual([
      {
        inviteId: 'invite-1',
        orgId: 'org-invited',
        teamId: 'team-invited',
        teamName: 'Invited team',
        invitedBy: 'Alice Admin',
        expiresAt: '2026-09-30T00:00:00.000Z',
      },
    ]);
  });

  it("resolves the token's own org, not whichever membership happens to come first", async () => {
    // A user can hold ACTIVE memberships in several organisations. `/org/me` must answer for the
    // org the token is scoped to — the same one `/org/organisations/:orgId/**` will accept — or
    // the sidebar and the surface it links to disagree.
    claimsMock.mockResolvedValue({
      userId: 'user-1',
      domain: 'product.example.com',
      org: { org_id: 'org-token', org_role: 'owner' },
    });
    getUserOrgContextMock.mockResolvedValue({
      org_id: 'org-token',
      tenant_slug: 'token-org',
      org_role: 'owner',
      teams: [],
      team_roles: {},
    });

    const response = await getOrgMe();

    expect(response.statusCode).toBe(200);
    expect(response.json().org.org_id).toBe('org-token');
    expect(getUserOrgContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', orgId: 'org-token' }),
      { prisma: transaction },
    );
    expect(getActiveClientOrgContextMock).not.toHaveBeenCalled();
  });

  it('falls back to the org claim when there is no same-domain context and no active claim', async () => {
    claimsMock.mockResolvedValue({
      userId: 'user-1',
      domain: 'product.example.com',
      org: { org_id: 'org-token', org_role: 'owner' },
    });

    await getOrgMe();

    expect(getActiveClientOrgContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-token' }),
      { prisma: transaction, policyPrisma: transaction, crossProductPrisma: transaction },
    );
  });

  it('does not invent a cross-domain legacy org for an unscoped token', async () => {
    claimsMock.mockResolvedValue({ userId: 'user-1', domain: 'product.example.com' });

    const response = await getOrgMe();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, system_admin: false });
    expect(getActiveClientOrgContextMock).not.toHaveBeenCalled();
    expect(buildSidebarTeamsMock).not.toHaveBeenCalled();
  });

  it('keeps the directory absent when the selected cross-product context no longer validates', async () => {
    getActiveClientOrgContextMock.mockResolvedValue(null);

    const response = await getOrgMe();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, system_admin: false });
    expect(getActiveClientOrgContextMock).toHaveBeenCalled();
    expect(buildSidebarTeamsMock).not.toHaveBeenCalled();
  });

  it('threads one transaction through the authority, policy, directory, invitation and self reads', async () => {
    claimsMock.mockResolvedValue({ userId: 'user-1', tokenVersion: 0, domain: config.domain,
      active: { orgId: 'org-cross', teamId: 'team-cross' }, assuranceId: 'assurance-1' });
    expect((await getOrgMe()).statusCode).toBe(200);
    expect(adminReadMock).toHaveBeenCalledTimes(1);
    expect(authorityMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), transaction,
      transaction, { userEpochLock: 'shared' });
    expect(assuranceMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'assurance-1',
      credentialEpoch: 0, orgId: 'org-cross', teamId: 'team-cross' }), transaction);
    expect(isPlatformSuperuserMock).toHaveBeenCalledWith({ userId: 'user-1', prisma: transaction });
    expect(resolveProductTeamPolicyMock).toHaveBeenCalledWith({ domain: config.domain }, { prisma: transaction });
    expect(buildSidebarTeamsMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      prisma: transaction, crossProductPrisma: transaction }));
    expect(buildSidebarPendingInvitesMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      prisma: transaction, invitePrisma: transaction }));
    expect(transaction.user.findUniqueOrThrow).toHaveBeenCalledTimes(1);
  });

  it.each(['authority', 'assurance'] as const)('fails closed when the pinned %s check rejects', async (check) => {
    claimsMock.mockResolvedValue({ userId: 'user-1', tokenVersion: 0, domain: config.domain,
      active: { orgId: 'org-cross', teamId: 'team-cross' }, assuranceId: 'assurance-1' });
    (check === 'authority' ? authorityMock : assuranceMock).mockRejectedValueOnce(new AppError('UNAUTHORIZED', 401));
    expect((await getOrgMe()).statusCode).toBe(401);
    expect(isPlatformSuperuserMock).not.toHaveBeenCalled();
    expect(buildSidebarTeamsMock).not.toHaveBeenCalled();
    expect(transaction.user.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});
