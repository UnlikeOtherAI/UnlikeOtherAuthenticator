import fastify from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';

// Route-level proof that GET /org/organisations/:orgId/members really passes
// the acting user through to listOrganisationMembers. The service's actor gate
// is deliberately SKIPPED when no actor is declared (backend mode), so a
// dropped `...orgCaller(request)` spread in the route would turn the
// defence-in-depth membership check into a silent no-op — and the whole unit
// suite stays green. This test fails on exactly that revert: with the spread
// dropped the list succeeds (200) instead of rejecting a non-member (403).

const claimsMock = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  organisation: { findFirst: vi.fn() },
  orgMember: { findFirst: vi.fn(), findMany: vi.fn() },
}));

const config = {
  domain: 'product.example.com',
  org_features: { enabled: true, groups_enabled: false },
} as ClientConfig;

vi.mock('../../src/middleware/domain-hash-auth.js', () => {
  // `acceptDomainBackendCaller` in requireOrgRole keys on the fields the real
  // middleware stamps, so set them even though this request goes down the
  // user-token branch.
  const requireDomainHashAuthForDomainQuery = () => async (request: {
    domainAuthClientId?: string;
    domainAuthClientDomainId?: string;
  }) => {
    request.domainAuthClientId = 'domain-hash-client';
    request.domainAuthClientDomainId = 'cd_row123';
  };
  return {
    default: requireDomainHashAuthForDomainQuery,
    requireDomainHashAuthForDomainQuery,
  };
});

vi.mock('../../src/middleware/config-verifier.js', () => ({
  configVerifier: async (request: { config?: ClientConfig }): Promise<void> => {
    request.config = config;
  },
}));

vi.mock('../../src/middleware/org-role-guard.js', () => {
  // Partial mock would be ideal (the real requireOrgRole with only the token
  // verification stubbed), but the module's exported factory closes over its
  // own module-scope resolveActingUserClaims, so a partial mock cannot reach
  // it. Reimplementing the guard here would not test the source under test,
  // so instead the test asserts the actor propagation below the guard: claims
  // are stamped exactly as the real requireOrgRole would stamp them.
  return {
    parseBearerOrRawToken: (value: unknown) =>
      typeof value === 'string' ? value.trim().replace(/^bearer /i, '') : null,
    requireOrgRole: () => async (request: {
      accessTokenClaims?: unknown;
      headers: Record<string, string | undefined>;
    }) => {
      request.accessTokenClaims = await claimsMock(request.headers['x-uoa-access-token']);
    },
  };
});

vi.mock('../../src/plugins/tenant-context.plugin.js', () => ({
  setTenantContextFromRequest: vi.fn(),
}));

vi.mock('../../src/db/tenant-context.js', () => ({
  asPrismaClient: (value: unknown) => value,
}));

async function listMembers() {
  const { registerOrganisationMemberRoutes } = await import(
    '../../src/routes/org/organisation-members.js'
  );
  const app = fastify();
  app.decorateRequest('withTenantTx', null);
  app.addHook('onRequest', async (request) => {
    request.withTenantTx = async (callback) => callback(prismaMock as never);
  });
  registerOrganisationMemberRoutes(app);
  await app.ready();
  try {
    return await app.inject({
      method: 'GET',
      url: '/org/organisations/org-1/members?domain=product.example.com&config_url=https%3A%2F%2Fproduct.example.com%2Fauth-config',
      headers: { 'x-uoa-access-token': 'Bearer user-token' },
    });
  } finally {
    await app.close();
  }
}

// getEnv() is cached per test file; assertDatabaseEnabled only needs a URL.
const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = 'postgres://example.invalid/db';

describe('GET /org/organisations/:orgId/members actor gate', () => {
  afterAll(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // A valid user token for the right domain, scoped to org-1 — so
    // requireOrgRole accepts the request and hands the route an acting user.
    claimsMock.mockResolvedValue({
      userId: 'user-1',
      domain: 'product.example.com',
      org: { org_id: 'org-1', org_role: 'member' },
    });

    prismaMock.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'product.example.com',
      name: 'Product Org',
      slug: 'product-org',
      ownerId: 'user-0',
      memberInvites: 'disabled',
      iconUrl: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    // The acting user has NO active membership in org-1 (stale token, or the
    // membership was deactivated after the token was issued).
    prismaMock.orgMember.findFirst.mockResolvedValue(null);
    prismaMock.orgMember.findMany.mockResolvedValue([]);
  });

  it('rejects a user-token caller who is not an active member with 403', async () => {
    const response = await listMembers();

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
    // The membership gate ran before the list query — i.e. the route passed
    // the actor through rather than silently running in backend mode.
    expect(prismaMock.orgMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: 'org-1', userId: 'user-1', status: 'ACTIVE' },
      }),
    );
    expect(prismaMock.orgMember.findMany).not.toHaveBeenCalled();
  });
});
