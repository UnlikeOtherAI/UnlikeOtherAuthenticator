import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FastifyRequest, FastifyReply } from 'fastify';

import { requireOrgRole } from '../org-role-guard.js';

const verifyAccessTokenMock = vi.fn();

vi.mock('../../services/access-token.service.js', () => {
  return {
    verifyAccessToken: (...args: unknown[]) => verifyAccessTokenMock(...args),
  };
});

/**
 * A request shaped exactly as the `/org/*` preValidation chain leaves it just before
 * `requireOrgRole` runs on a backend-mode call: domain-hash guard passed, config verified,
 * no user token.
 */
function makeBackendRequest(overrides: { params?: { orgId?: string } } = {}) {
  return {
    headers: {},
    domainAuthClientDomainId: 'cd_1',
    query: { domain: 'client.example.com' },
    config: {
      domain: 'client.example.com',
      org_features: { enabled: true, backend_org_management: true },
    },
    ...(overrides.params ? { params: overrides.params } : {}),
  } as unknown as FastifyRequest;
}

/**
 * Backend mode's tenant boundary. User-mode calls are no longer origin-domain-scoped — one
 * organisation is usable from every UOA-integrated product, gated by the token's org claim plus
 * live membership — but a backend call has no acting user and no membership to check, so the
 * org's ORIGIN domain (`organisations.domain`) is the only boundary it can have. It lives here
 * and nowhere else, so these pin it.
 */
describe('requireOrgRole — backend mode is scoped to the org origin domain', () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    verifyAccessTokenMock.mockReset();
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  function withAdminDb(request: FastifyRequest, row: { id: string } | null) {
    const findFirst = vi.fn().mockResolvedValue(row);
    (request as unknown as { adminDb: unknown }).adminDb = { organisation: { findFirst } };
    return findFirst;
  }

  it('accepts an org created on the verified domain', async () => {
    process.env.DATABASE_URL = 'postgres://org-role-guard-tests.invalid/db';
    const middleware = requireOrgRole();
    const request = makeBackendRequest({ params: { orgId: 'org_1' } });
    const findFirst = withAdminDb(request, { id: 'org_1' });

    await middleware(request, {} as FastifyReply);

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'org_1', domain: 'client.example.com' },
      select: { id: true },
    });
    expect(request.orgBackendCaller).toEqual({ domain: 'client.example.com' });
  });

  it('refuses an org another product created — the same generic 404 the resolver used to give', async () => {
    process.env.DATABASE_URL = 'postgres://org-role-guard-tests.invalid/db';
    const middleware = requireOrgRole('owner', 'admin');
    const request = makeBackendRequest({ params: { orgId: 'org_elsewhere' } });
    withAdminDb(request, null);

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    expect(request.orgBackendCaller).toBeUndefined();
  });

  it('does not query at all on a route with no :orgId', async () => {
    process.env.DATABASE_URL = 'postgres://org-role-guard-tests.invalid/db';
    const middleware = requireOrgRole();
    const request = makeBackendRequest();
    const findFirst = withAdminDb(request, null);

    await middleware(request, {} as FastifyReply);

    expect(findFirst).not.toHaveBeenCalled();
    expect(request.orgBackendCaller).toEqual({ domain: 'client.example.com' });
  });

  // Mirrors the DB-less no-op the tenant-context plugin already takes: with no database there is
  // no `adminDb` and no organisation rows to scope to.
  it('skips the check when no database is configured', async () => {
    delete process.env.DATABASE_URL;
    const middleware = requireOrgRole();
    const request = makeBackendRequest({ params: { orgId: 'org_1' } });

    await middleware(request, {} as FastifyReply);

    expect(request.orgBackendCaller).toEqual({ domain: 'client.example.com' });
  });
});
