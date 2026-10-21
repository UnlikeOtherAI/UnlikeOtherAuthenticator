import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenClaims } from '../../services/access-token.service.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

import { AppError } from '../../utils/errors.js';
import { requireOrgRole } from '../org-role-guard.js';

const verifyAccessTokenMock = vi.fn();

vi.mock('../../services/access-token.service.js', () => {
  return {
    verifyAccessToken: (...args: unknown[]) => verifyAccessTokenMock(...args),
  };
});

function buildClaims(overrides: Partial<AccessTokenClaims> = {}): AccessTokenClaims {
  return {
    userId: 'user_1',
    tokenVersion: 0,
    email: 'user@example.com',
    domain: 'client.example.com',
    clientId: 'client-id',
    role: 'user',
    ...overrides,
  };
}

function makeRequest(token: string | null, domain: string, params?: { orgId?: string }) {
  const headers: Record<string, string | undefined> = {};
  if (token !== null) {
    headers['x-uoa-access-token'] = token;
  }

  return {
    headers,
    config: { domain },
    ...(params ? { params } : {}),
  } as unknown as FastifyRequest;
}

/**
 * A request shaped exactly as the `/org/*` preValidation chain leaves it just
 * before `requireOrgRole` runs on a backend-mode call: domain-hash guard passed,
 * config verified, no user token.
 */
function makeBackendRequest(
  overrides: {
    domainAuthClientDomainId?: string | undefined;
    configDomain?: string | undefined;
    queryDomain?: string;
    backendOrgManagement?: boolean;
    params?: { orgId?: string };
  } = {},
) {
  const configDomain =
    'configDomain' in overrides ? overrides.configDomain : 'client.example.com';

  return {
    headers: {},
    domainAuthClientDomainId:
      'domainAuthClientDomainId' in overrides
        ? overrides.domainAuthClientDomainId
        : 'cd_1',
    query: { domain: overrides.queryDomain ?? 'client.example.com' },
    config: {
      ...(configDomain === undefined ? {} : { domain: configDomain }),
      org_features: {
        enabled: true,
        backend_org_management: overrides.backendOrgManagement ?? true,
      },
    },
    ...(overrides.params ? { params: overrides.params } : {}),
  } as unknown as FastifyRequest;
}

describe('requireOrgRole middleware', () => {
  afterEach(() => {
    verifyAccessTokenMock.mockReset();
  });

  it('rejects when token verification fails', async () => {
    verifyAccessTokenMock.mockRejectedValueOnce(new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN'));
    const middleware = requireOrgRole('admin');
    const request = makeRequest('bad-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'INVALID_ACCESS_TOKEN',
    });
  });

  it('rejects when token domain does not match request domain', async () => {
    verifyAccessTokenMock.mockResolvedValueOnce(
      buildClaims({ domain: 'other.example.com' }),
    );
    const middleware = requireOrgRole('admin');
    const request = makeRequest('Bearer valid-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'ACCESS_TOKEN_DOMAIN_MISMATCH',
    });
  });

  it('rejects when org claim is missing and roles are required', async () => {
    verifyAccessTokenMock.mockResolvedValueOnce(
      buildClaims(),
    );
    const middleware = requireOrgRole('admin');
    const request = makeRequest('Bearer valid-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'INSUFFICIENT_ORG_ROLE',
    });
  });

  it('rejects when org role is not allowed', async () => {
    verifyAccessTokenMock.mockResolvedValueOnce(
      buildClaims({ org: { org_id: 'org_1', org_role: 'member', teams: [], team_roles: {} } }),
    );
    const middleware = requireOrgRole('admin');
    const request = makeRequest('valid-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'INSUFFICIENT_ORG_ROLE',
    });
  });

  it('passes with allowed org role', async () => {
    const claims = buildClaims({
      org: { org_id: 'org_1', org_role: 'admin', teams: [], team_roles: {} },
    });
    verifyAccessTokenMock.mockResolvedValueOnce(claims);
    const middleware = requireOrgRole('admin', 'owner');
    const request = makeRequest('valid-token', 'client.example.com');

    await middleware(request, {} as FastifyReply);

    expect(request.accessTokenClaims).toEqual(claims);
  });

  it('passes when no required roles are configured', async () => {
    const claims = buildClaims();
    verifyAccessTokenMock.mockResolvedValueOnce(claims);
    const middleware = requireOrgRole();
    const request = makeRequest('valid-token', 'client.example.com');

    await middleware(request, {} as FastifyReply);

    expect(request.accessTokenClaims).toEqual(claims);
  });
});

/**
 * Mutation-resistance cases for the guard itself.
 *
 * The suite above proves call ordering against a mocked verifier. These prove
 * that specific lines of `org-role-guard.ts` cannot be deleted while the suite
 * stays green.
 */
describe('requireOrgRole — checks that must not be deletable', () => {
  afterEach(() => {
    verifyAccessTokenMock.mockReset();
  });

  // Defends the `orgId` match INSIDE the `requiredRoles.length > 0` branch.
  // The cross-org test above calls `requireOrgRole()` with no roles, so it only
  // exercises the role-less branch; deleting the guarded match left it green while
  // an owner token for org A reached org B's owner-only endpoints, which do not
  // re-check the actor themselves.
  it('rejects a token whose org role is sufficient but whose org is a different one', async () => {
    verifyAccessTokenMock.mockResolvedValueOnce(
      buildClaims({
        org: { org_id: 'org_other', org_role: 'owner', teams: [], team_roles: {} },
      }),
    );
    const middleware = requireOrgRole('owner', 'admin');
    const request = makeRequest('user-token', 'client.example.com', { orgId: 'org_1' });

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'INSUFFICIENT_ORG_ROLE',
    });
  });

  // The user-token verifier's error object must reach the caller UNCHANGED. A
  // Prisma outage surfaces from `verifyAccessToken` as a 5xx; replacing it with a
  // fresh 401 would turn every database blip into what looks to a client like a
  // logout, and clients would discard otherwise-valid sessions.
  it('rethrows the original error object from the user-token verifier', async () => {
    const outage = new Error('prisma: connection terminated unexpectedly');
    verifyAccessTokenMock.mockRejectedValueOnce(outage);
    const middleware = requireOrgRole('admin');
    const request = makeRequest('user-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toBe(outage);
  });
});

/**
 * Backend mode: no `x-uoa-access-token` at all. The domain pairing that already
 * ran on the route is the authorisation, and there is deliberately no acting
 * user. `request.orgBackendCaller` is the only signal downstream code has for
 * that, so these pin exactly when it is and is not set.
 */
describe('requireOrgRole — domain-pairing backend mode', () => {
  afterEach(() => {
    verifyAccessTokenMock.mockReset();
  });

  it('accepts a call with no user token when the domain opted in', async () => {
    const middleware = requireOrgRole();
    const request = makeBackendRequest();

    await middleware(request, {} as FastifyReply);

    expect(request.orgBackendCaller).toEqual({ domain: 'client.example.com' });
    expect(request.accessTokenClaims).toBeUndefined();
    // Backend mode must not consult the user-token verifier at all.
    expect(verifyAccessTokenMock).not.toHaveBeenCalled();
  });

  // Required roles are a statement about a USER's standing in an org. A backend
  // call has no user, so the guard admits it and the service layer's non-actor
  // invariants remain the only gate — see the per-route table in /llm §4.6b.
  it('accepts a backend call on a route that requires an org role', async () => {
    const middleware = requireOrgRole('owner', 'admin');
    const request = makeBackendRequest({ params: { orgId: 'org_1' } });

    await middleware(request, {} as FastifyReply);

    expect(request.orgBackendCaller).toEqual({ domain: 'client.example.com' });
  });

  // The opt-in is what separates this from the historical behaviour. Without it
  // the response must be byte-identical to what a missing token always produced.
  it('rejects a call with no user token when the domain has not opted in', async () => {
    const middleware = requireOrgRole('admin');
    const request = makeBackendRequest({ backendOrgManagement: false });

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'MISSING_ACCESS_TOKEN',
    });
    expect(request.orgBackendCaller).toBeUndefined();
  });

  it('rejects a call with no user token when org_features carries no flag at all', async () => {
    const middleware = requireOrgRole();
    const request = makeBackendRequest();
    (request.config as { org_features?: unknown }).org_features = { enabled: true };

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'MISSING_ACCESS_TOKEN',
    });
    expect(request.orgBackendCaller).toBeUndefined();
  });

  // The guard must not depend on its position in the preValidation array. If the
  // domain-hash guard never ran, half the pairing is missing and there is no
  // proof of who the caller is.
  it('rejects backend mode when the domain-hash guard did not run', async () => {
    const middleware = requireOrgRole();
    const request = makeBackendRequest({ domainAuthClientDomainId: undefined });

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'MISSING_ACCESS_TOKEN',
    });
    expect(request.orgBackendCaller).toBeUndefined();
  });

  it('rejects backend mode when no config was verified', async () => {
    const middleware = requireOrgRole();
    const request = makeBackendRequest({ configDomain: undefined });

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'INTERNAL',
      statusCode: 500,
      message: 'CONFIG_NOT_VERIFIED',
    });
    expect(request.orgBackendCaller).toBeUndefined();
  });

  // The tenant a backend call acts on must never be steerable by the query
  // string. Only the signed config's `domain` decides.
  it('rejects a query domain that differs from the verified config domain', async () => {
    const middleware = requireOrgRole();
    const request = makeBackendRequest({ queryDomain: 'other.example.com' });

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
      message: 'DOMAIN_MISMATCH',
    });
    expect(request.orgBackendCaller).toBeUndefined();
  });

  it('binds to the verified config domain, not the query value', async () => {
    const middleware = requireOrgRole();
    const request = makeBackendRequest({
      configDomain: 'CLIENT.example.com',
      queryDomain: 'client.example.com',
    });

    await middleware(request, {} as FastifyReply);

    expect(request.orgBackendCaller).toEqual({ domain: 'client.example.com' });
  });

  // The case above cannot tell "verified config domain" from "the raw ?domain=
  // value" — both normalise to the same string. Flipping which side carries the
  // odd casing does: a provenance taken from the raw query would keep the
  // uppercase form here. The recorded source domain must always be the value
  // the signature covered.
  it('records the verified domain even when the query value is differently cased', async () => {
    const middleware = requireOrgRole();
    const request = makeBackendRequest({
      configDomain: 'client.example.com',
      queryDomain: 'CLIENT.Example.COM',
    });

    await middleware(request, {} as FastifyReply);

    expect(request.orgBackendCaller).toEqual({ domain: 'client.example.com' });
  });

  // A present-but-unusable header is NOT backend mode. It is a bad token, and it
  // must keep failing as one — otherwise a caller whose token expired would
  // silently be upgraded to unauthenticated-but-authorised.
  it('does not fall back to backend mode when a user token is present but invalid', async () => {
    verifyAccessTokenMock.mockRejectedValueOnce(
      new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN'),
    );
    const middleware = requireOrgRole();
    const request = makeBackendRequest();
    (request.headers as Record<string, string>)['x-uoa-access-token'] = 'expired-token';

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'INVALID_ACCESS_TOKEN',
    });
    expect(request.orgBackendCaller).toBeUndefined();
  });

  // An RS256 `at+jwt` confidential resource token is exactly what PR #19 used to
  // accept here. It must now be just another invalid user token.
  it('rejects a confidential RS256 at+jwt resource token like any other bad token', async () => {
    verifyAccessTokenMock.mockRejectedValueOnce(
      new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN'),
    );
    const middleware = requireOrgRole();
    const confidentialToken = [
      Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'at+jwt', kid: 'uoa-1' })).toString(
        'base64url',
      ),
      Buffer.from(JSON.stringify({ scope: 'token.provision', sub: 'user_1' })).toString(
        'base64url',
      ),
      'c2ln',
    ].join('.');
    const request = makeBackendRequest();
    (request.headers as Record<string, string>)['x-uoa-access-token'] = confidentialToken;

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'INVALID_ACCESS_TOKEN',
    });
    expect(request.orgBackendCaller).toBeUndefined();
    // Exactly one verifier was consulted — there is no second acceptance path.
    expect(verifyAccessTokenMock).toHaveBeenCalledTimes(1);
  });

  // A PRESENT but blank header is a malformed credential, never "no credential".
  // Collapsing the two would let a BFF that forwards an anonymous visitor's
  // empty session token execute as the whole tenant's backend, so each blank
  // shape is pinned to a 401 and must never reach backend mode.
  it.each([
    ['empty string', ''],
    ['spaces', '   '],
    ['tab', '\t'],
    ['newline', '\n'],
    ['carriage return + newline', '\r\n'],
    ['mixed whitespace', ' \t\r\n '],
  ])('rejects a present-but-blank access token header (%s)', async (_label, headerValue) => {
    const middleware = requireOrgRole();
    const request = makeBackendRequest();
    (request.headers as Record<string, string>)['x-uoa-access-token'] = headerValue;

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'MISSING_ACCESS_TOKEN',
    });
    expect(request.orgBackendCaller).toBeUndefined();
  });

  // Repeating the header is NOT delivered as an array: Node's HTTP/1.1 and
  // HTTP/2 parsers collapse duplicates of a custom header into one comma-joined
  // string, verified against a real socket —
  //   X-UOA-Access-Token: aaa.bbb.ccc
  //   X-UOA-Access-Token: ddd.eee.fff
  //   => req.headers['x-uoa-access-token'] === 'aaa.bbb.ccc, ddd.eee.fff'
  // So THIS is the shape the guard actually meets, and it must not verify.
  it('rejects the comma-joined string Node produces for a repeated header', async () => {
    const middleware = requireOrgRole();
    const request = makeBackendRequest();
    (request.headers as Record<string, string>)['x-uoa-access-token'] =
      'aaa.bbb.ccc, ddd.eee.fff';

    verifyAccessTokenMock.mockRejectedValueOnce(
      new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN'),
    );

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
    // The joined value went to the verifier as one opaque credential — it was
    // never split, and it never selected backend mode.
    expect(verifyAccessTokenMock).toHaveBeenCalledWith('aaa.bbb.ccc, ddd.eee.fff', { requirement: 'enterprise_org_access' });
    expect(request.orgBackendCaller).toBeUndefined();
  });

  // An array cannot arrive from Node, but `IncomingHttpHeaders` types it as
  // possible, so a non-Node front end (or a direct `inject`) could still hand
  // one over. It is not a `string`, so it falls through the same type check to
  // the same 401 — there is no branch that could pick one of the values.
  it('rejects a non-string header value without picking one of its parts', async () => {
    const middleware = requireOrgRole();
    const request = makeBackendRequest();
    (request.headers as Record<string, string[]>)['x-uoa-access-token'] = ['a.b.c', 'd.e.f'];

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'MISSING_ACCESS_TOKEN',
    });
    expect(verifyAccessTokenMock).not.toHaveBeenCalled();
    expect(request.orgBackendCaller).toBeUndefined();
  });

  // The counterpart: a genuinely absent header is still the one and only way
  // into backend mode.
  it('selects backend mode only when the header is absent', async () => {
    const middleware = requireOrgRole();
    const request = makeBackendRequest();
    delete (request.headers as Record<string, unknown>)['x-uoa-access-token'];

    await middleware(request, {} as FastifyReply);

    expect(request.orgBackendCaller).toEqual({ domain: 'client.example.com' });
  });
});
