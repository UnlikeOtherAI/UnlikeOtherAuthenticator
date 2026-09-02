// `requireOrgBackendOnly` — the guard for a route that has NO user mode.
//
// `requireOrgRole` decides between two principals. This one decides between one
// principal and a refusal, and the refusal is the point: `GET /org/organisations`
// previously ran no guard at all, so a present `X-UOA-Access-Token` was neither
// verified nor rejected — it was ignored, and the caller got the whole domain's
// organisation list regardless of what it sent.
import { describe, expect, it, vi } from 'vitest';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireOrgBackendOnly } from '../org-role-guard.js';

const verifyAccessTokenMock = vi.fn();

vi.mock('../../services/access-token.service.js', () => {
  return {
    verifyAccessToken: (...args: unknown[]) => verifyAccessTokenMock(...args),
  };
});

/** The request as the `/org/*` preValidation chain leaves it for a backend call. */
function makeBackendRequest(
  overrides: {
    domainAuthClientDomainId?: string | undefined;
    configDomain?: string | undefined;
    queryDomain?: string;
    backendOrgManagement?: boolean;
    accessToken?: string;
    subjectAssertion?: string;
  } = {},
) {
  const configDomain =
    'configDomain' in overrides ? overrides.configDomain : 'client.example.com';

  return {
    headers: {
      ...('accessToken' in overrides ? { 'x-uoa-access-token': overrides.accessToken } : {}),
      ...('subjectAssertion' in overrides
        ? { 'x-uoa-subject-assertion': overrides.subjectAssertion }
        : {}),
    },
    domainAuthClientDomainId:
      'domainAuthClientDomainId' in overrides ? overrides.domainAuthClientDomainId : 'cd_1',
    query: { domain: overrides.queryDomain ?? 'client.example.com' },
    config: {
      ...(configDomain === undefined ? {} : { domain: configDomain }),
      org_features: {
        enabled: true,
        backend_org_management: overrides.backendOrgManagement ?? true,
      },
    },
  } as unknown as FastifyRequest;
}

describe('requireOrgBackendOnly middleware', () => {
  it('accepts the domain pairing when no user token is present', async () => {
    const request = makeBackendRequest();

    await requireOrgBackendOnly()(request, {} as FastifyReply);

    expect(request.orgBackendCaller).toEqual({ domain: 'client.example.com' });
  });

  // Every shape that is "present but carries no usable credential". On a guarded
  // route these reach the blank-token blocker; on this route the header never
  // reached a blocker at all, which is the bug being closed. The list is
  // deliberately wider than plain ASCII whitespace: `String.prototype.trim` also
  // strips NBSP, form feed and vertical tab, so a blank-check that trims is not
  // obviously equivalent to a blank-check that does not.
  it.each([
    ['empty string', ''],
    ['single space', ' '],
    ['spaces', '   '],
    ['tab', '\t'],
    ['newline', '\n'],
    ['carriage return', '\r'],
    ['form feed', '\f'],
    ['vertical tab', '\v'],
    ['no-break space (U+00A0)', ' '],
    ['Bearer + space', 'Bearer '],
    ['Bearer + tab', 'Bearer\t'],
    ['lowercase bearer + spaces', 'bearer   '],
    ['uppercase BEARER + space', 'BEARER '],
  ])('refuses a present-but-blank access token header (%s)', async (_label, accessToken) => {
    const request = makeBackendRequest({ accessToken });

    await expect(requireOrgBackendOnly()(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'ACCESS_TOKEN_NOT_ALLOWED',
    });
    expect(request.orgBackendCaller).toBeUndefined();
  });

  // A perfectly good user token is refused too. The route has nothing to do with
  // one, and "ignore it" is precisely the behaviour that leaked the domain list.
  it('refuses a well-formed user token instead of ignoring it', async () => {
    const request = makeBackendRequest({ accessToken: 'Bearer aaa.bbb.ccc' });

    await expect(requireOrgBackendOnly()(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'ACCESS_TOKEN_NOT_ALLOWED',
    });
    // It is refused on presence alone — no verification, so no oracle about
    // whether the token was valid.
    expect(verifyAccessTokenMock).not.toHaveBeenCalled();
    expect(request.orgBackendCaller).toBeUndefined();
  });

  it('refuses a subject assertion instead of ignoring it', async () => {
    const request = makeBackendRequest({ subjectAssertion: 'aaa.bbb.ccc' });

    await expect(requireOrgBackendOnly()(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'ACCESS_TOKEN_NOT_ALLOWED',
    });
    expect(request.orgBackendCaller).toBeUndefined();
  });

  // The pairing checks are the same three `requireOrgRole` runs, re-checked here
  // rather than assumed from the order of the preValidation array.
  it('refuses when the domain-hash guard did not run', async () => {
    const request = makeBackendRequest({ domainAuthClientDomainId: undefined });

    await expect(requireOrgBackendOnly()(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'MISSING_ACCESS_TOKEN',
    });
    expect(request.orgBackendCaller).toBeUndefined();
  });

  it('refuses when the domain has not opted into backend org management', async () => {
    const request = makeBackendRequest({ backendOrgManagement: false });

    await expect(requireOrgBackendOnly()(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'MISSING_ACCESS_TOKEN',
    });
    expect(request.orgBackendCaller).toBeUndefined();
  });

  it('binds to the verified config domain, not the query string', async () => {
    const request = makeBackendRequest({ queryDomain: 'attacker.example.com' });

    await expect(requireOrgBackendOnly()(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
      message: 'DOMAIN_MISMATCH',
    });
    expect(request.orgBackendCaller).toBeUndefined();
  });
});
