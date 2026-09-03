import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../utils/errors.js';
import { verifyAccessToken, type AccessTokenClaims } from '../services/access-token.service.js';
import { verifyConfidentialSubjectToken } from '../services/confidential-token-exchange.service.js';
import {
  isAuthenticationEpochMismatchError,
  lockAndAssertAuthenticationEpoch,
} from '../services/authentication-epoch.service.js';
import { getActiveClientOrgContext } from '../services/org-context.service.js';
import { normalizeDomain } from '../utils/domain.js';
import { getEnv } from '../config/env.js';

function resolveDomainFromRequest(request: FastifyRequest): string {
  const queryDomain = typeof request.query === 'object' && request.query !== null
    ? (request.query as { domain?: unknown }).domain
    : undefined;
  const normalizedQueryDomain =
    typeof queryDomain === 'string' ? normalizeDomain(queryDomain) : undefined;

  const configDomain = typeof request.config?.domain === 'string' ? normalizeDomain(request.config.domain) : undefined;
  return normalizedQueryDomain || configDomain || '';
}

function resolveOrgIdFromParams(request: FastifyRequest): string | undefined {
  const params = request.params as { orgId?: string } | undefined;
  if (!params?.orgId) return undefined;
  const orgId = params.orgId.trim();
  return orgId || undefined;
}

function resolveTeamIdFromParams(request: FastifyRequest): string | undefined {
  const params = request.params as { teamId?: string } | undefined;
  if (!params?.teamId) return undefined;
  const teamId = params.teamId.trim();
  return teamId || undefined;
}

export function parseBearerOrRawToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('bearer ')) {
    const token = trimmed.slice('bearer '.length).trim();
    return token ? token : null;
  }

  return trimmed;
}

export const ORG_ACCESS_TOKEN_HEADER = 'x-uoa-access-token';
export const ORG_SUBJECT_ASSERTION_HEADER = 'x-uoa-subject-assertion';
export const ORG_SUBJECT_ASSERTION_AUDIENCE = 'https://authentication.unlikeotherai.com/org';

function invalidSubjectAssertion(): AppError {
  return new AppError('UNAUTHORIZED', 401, 'INVALID_SUBJECT_TOKEN');
}

/**
 * Resolve `X-UOA-Access-Token` into either a token or "the caller deliberately
 * sent no user credential".
 *
 * This distinction is load-bearing and must never be collapsed. An ABSENT
 * header selects backend mode, which carries authority over the entire tenant.
 * A header that is PRESENT but blank — `""`, `"   "`, a tab, a newline,
 * `"Bearer "` — is a MALFORMED CREDENTIAL, not an absent one. The realistic
 * source is a partner BFF that attaches the domain-hash bearer server-side and
 * forwards the end user's session token: for an anonymous visitor that token is
 * the empty string, and treating it as "omitted" would promote an anonymous
 * visitor to the whole tenant's backend.
 *
 * So: blank-but-present is a 401, exactly like a token that fails to verify.
 * Only a genuinely missing header returns `null`.
 */
export function resolveOrgAccessTokenHeader(request: FastifyRequest): string | null {
  const raw = request.headers[ORG_ACCESS_TOKEN_HEADER];
  if (raw === undefined) return null;

  // A repeated header needs no special case. Node's HTTP/1.1 and HTTP/2 parsers
  // collapse duplicates of a custom header into ONE comma-joined string
  // (`"a.b.c, d.e.f"`), which is not a JWT and fails verification — and if some
  // non-Node front end ever handed us an array instead, it is not a `string`, so
  // `parseBearerOrRawToken` returns null and this throws. Both shapes end at the
  // same 401; neither can pick a credential.
  const token = parseBearerOrRawToken(raw);
  if (!token) {
    throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
  }
  return token;
}

/**
 * Resolve the separate assertion credential without ever treating a malformed
 * value as an omitted header. A JWT cannot contain a comma, so reject the
 * comma-joined shape Node uses for repeated custom headers as well.
 */
function resolveOrgSubjectAssertionHeader(request: FastifyRequest): string | null {
  const raw = request.headers[ORG_SUBJECT_ASSERTION_HEADER];
  if (raw === undefined) return null;

  const assertion = parseBearerOrRawToken(raw);
  if (!assertion || assertion.includes(',')) {
    throw invalidSubjectAssertion();
  }
  return assertion;
}

declare module 'fastify' {
  interface FastifyRequest {
    accessTokenClaims?: AccessTokenClaims;
    /**
     * Set by `requireOrgRole` and `requireOrgBackendOnly` — and by nothing else —
     * when the request was accepted on the domain pairing alone, with neither
     * user credential present. Both writers go through the single
     * `acceptDomainBackendCaller` below, so both ran the same three checks
     * including the `backend_org_management` opt-in.
     *
     * Its presence is the ONLY proof that "there is deliberately no acting user"
     * rather than "the acting user is missing". Route helpers key on it before
     * they are willing to call a service without an `actorUserId`, and
     * `setTenantContextFromRequest` derives `app.domain_backend` from it — there
     * is no way to assert that GUC without having passed through here.
     */
    orgBackendCaller?: { domain: string };
  }
}

function normalizeOrgId(value: string): string {
  return value.trim();
}

/**
 * Resolve the acting user behind `x-uoa-access-token`.
 *
 * There is exactly ONE user-token profile on `/org/*`: the HS256 access token.
 * Every failure mode, error code, and the DB-error passthrough that must never
 * look like a logout are `verifyAccessToken`'s own, unchanged.
 *
 * A product backend that wants to drive `/org/*` server-to-server presents
 * neither user credential and is authorised by the domain pairing
 * (`requireDomainHashAuthForDomainQuery` + `configVerifier`).
 * See `requireOrgRole` below.
 */
export async function resolveActingUserClaims(token: string): Promise<AccessTokenClaims> {
  return await verifyAccessToken(token);
}

/**
 * Convert a one-minute RS256 subject assertion into the same claims shape the
 * normal role gate consumes. The assertion is only an authentication handoff:
 * its team claim is always re-resolved against current memberships before
 * it can act on an organisation route.
 */
async function resolveSubjectAssertionClaims(
  request: FastifyRequest,
  subjectAssertion: string,
): Promise<AccessTokenClaims> {
  const sourceDomain = normalizeDomain(request.config?.domain ?? '');
  const configJwt = request.configJwt?.trim();
  if (!sourceDomain || !configJwt) throw invalidSubjectAssertion();

  const assertion = await verifyConfidentialSubjectToken({
    subjectToken: subjectAssertion,
    configJwt,
    sourceDomain,
    audience: ORG_SUBJECT_ASSERTION_AUDIENCE,
  });
  if (!assertion.active) throw invalidSubjectAssertion();

  const requestOrgId = resolveOrgIdFromParams(request);
  const requestTeamId = resolveTeamIdFromParams(request);
  if (
    (requestOrgId && normalizeOrgId(assertion.active.orgId) !== requestOrgId) ||
    (requestTeamId && normalizeOrgId(assertion.active.teamId) !== requestTeamId)
  ) {
    throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_ORG_ROLE');
  }

  let identity: { tokenVersion: number };
  try {
    identity = await lockAndAssertAuthenticationEpoch(
      {
        userId: assertion.sub,
        domain: sourceDomain,
        credentialEpoch: assertion.tv,
      },
      { prisma: request.adminDb },
    );
  } catch (error) {
    if (isAuthenticationEpochMismatchError(error)) throw invalidSubjectAssertion();
    throw error;
  }

  const [user, org] = await Promise.all([
    request.adminDb.user.findUnique({
      where: { id: assertion.sub },
      select: { email: true },
    }),
    getActiveClientOrgContext(
      {
        userId: assertion.sub,
        domain: sourceDomain,
        orgId: assertion.active.orgId,
        groupsEnabled: request.config?.org_features?.groups_enabled,
      },
      {
        crossProductPrisma: request.adminDb,
        policyPrisma: request.adminDb,
        prisma: request.adminDb,
      },
    ),
  ]);

  if (
    !user ||
    !org ||
    normalizeOrgId(org.org_id) !== normalizeOrgId(assertion.active.orgId) ||
    !org.teams.includes(assertion.active.teamId)
  ) {
    throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_ORG_ROLE');
  }

  return {
    userId: assertion.sub,
    tokenVersion: identity.tokenVersion,
    email: user.email,
    domain: sourceDomain,
    // Assertions identify a user and their live team, not an OAuth
    // client. This non-authoritative marker exists only because the shared
    // in-memory claims shape has a required clientId field.
    clientId: 'uoa-subject-assertion',
    role: 'user',
    org,
    active: {
      orgId: assertion.active.orgId,
      teamId: assertion.active.teamId,
      tenantSlug: org.tenant_slug,
    },
  };
}

function assertRequiredOrgRole(
  claims: AccessTokenClaims,
  orgId: string | undefined,
  requiredRoles: string[],
): void {
  if (requiredRoles.length > 0) {
    const memberOrgId = normalizeOrgId(claims.org?.org_id ?? '');
    if (!memberOrgId || !claims.org?.org_role) {
      throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_ORG_ROLE');
    }

    if (orgId && normalizeOrgId(memberOrgId) !== orgId) {
      throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_ORG_ROLE');
    }

    if (!requiredRoles.includes(claims.org.org_role)) {
      throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_ORG_ROLE');
    }
  } else if (orgId) {
    const memberOrgId = normalizeOrgId(claims.org?.org_id ?? '');
    if (!memberOrgId || memberOrgId !== orgId) {
      throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_ORG_ROLE');
    }
  }
}

/**
 * Accept the request on the domain pairing alone, with no acting user.
 *
 * The pairing — `requireDomainHashAuthForDomainQuery` (the per-domain hash
 * bearer) plus `configVerifier` (the partner's signed config JWT, tied to
 * `?domain=`) — already proves "this is the backend for domain X". That is the
 * SAME authentication `/org/organisations` (list), the bulk-invite branch of
 * `POST .../invitations`, `/domain/users`, and the `/internal/org/*` family
 * already run on, so nothing new is being trusted here.
 *
 * Four things must hold, and each is re-checked here rather than assumed from
 * the order of the preValidation array, so registering this guard without its
 * siblings fails closed instead of opening a hole:
 *
 *  1. the domain-hash guard actually ran and passed (`domainAuthClientDomainId`);
 *  2. a config JWT was verified, and its `domain` is what we bind to — never the
 *     raw `?domain=` query value;
 *  3. that verified domain opted in via `org_features.backend_org_management`;
 *  4. and, when the route names an `:orgId`, that org was CREATED on the verified domain.
 *
 * Without the opt-in this is exactly the old behaviour: 401 `MISSING_ACCESS_TOKEN`.
 *
 * (4) is the whole of backend mode's tenant boundary and lives only here. User-mode calls are no
 * longer origin-domain-scoped — one organisation is usable from every UOA-integrated product,
 * gated by the token's org claim plus live membership — but backend mode has no acting user and
 * no membership to check, so the org's origin domain is the only boundary it can have. Without
 * this check, dropping the domain predicate from the service resolvers would have handed every
 * domain backend the whole estate.
 */
async function acceptDomainBackendCaller(request: FastifyRequest, queryDomain: string): Promise<void> {
  // (1) The pairing's first half. `verifyDomainHashAuth` sets this only after a
  // constant-time match against the live per-domain secret.
  if (!request.domainAuthClientDomainId) {
    throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
  }

  // (2) The pairing's second half. Bind to the VERIFIED config domain, so the
  // tenant a backend call acts on can never be steered by the query string.
  const verifiedDomain = normalizeDomain(request.config?.domain ?? '');
  if (!verifiedDomain) {
    throw new AppError('INTERNAL', 500, 'CONFIG_NOT_VERIFIED');
  }
  if (queryDomain && queryDomain !== verifiedDomain) {
    throw new AppError('BAD_REQUEST', 400, 'DOMAIN_MISMATCH');
  }

  // (3) Explicit opt-in in the partner's own signed config.
  if (request.config?.org_features?.backend_org_management !== true) {
    throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
  }

  // (4) Origin-domain scope for backend mode. `:orgId` is the caller's own claim about which
  // tenant to act on, so it is checked against `organisations.domain` — the org's ORIGIN, the
  // product that created it. An org another product created is a 404, exactly the answer the
  // service resolvers used to give. Skipped with no database, mirroring the DB-less no-op the
  // tenant-context plugin already takes; there are no organisation rows to scope to.
  const orgId = resolveOrgIdFromParams(request);
  if (orgId && getEnv().DATABASE_URL) {
    const org = await request.adminDb.organisation.findFirst({
      where: { id: orgId, domain: verifiedDomain },
      select: { id: true },
    });
    if (!org) {
      throw new AppError('NOT_FOUND', 404);
    }
  }

  request.orgBackendCaller = { domain: verifiedDomain };
}

/**
 * Guard a route that has NO user mode at all.
 *
 * `GET /org/organisations` is domain-scoped by construction: it lists a whole
 * domain's organisations, there is no `:orgId` to scope to and no membership to
 * check, and user-scoped reads live on `/org/me`. Its authorization boundary IS
 * the domain pairing.
 *
 * Such a route must REFUSE a user credential, not ignore one. Ignoring it is
 * what made a blank `X-UOA-Access-Token` — the shape a partner BFF forwards for
 * an anonymous visitor — return the entire domain's organisation list: the
 * header never reached `resolveOrgAccessTokenHeader`, so the blank-token blocker
 * never ran. Any PRESENT header is therefore a 401 here, whether it is blank,
 * malformed, or a perfectly valid access token; there is nothing on this route
 * for a user token to mean.
 *
 * After that, the same `acceptDomainBackendCaller` every other backend-mode call
 * runs: domain-hash guard passed, verified config domain bound (never the raw
 * `?domain=`), and `org_features.backend_org_management` opted in. Listing a
 * domain's organisations with no user token is exactly what that flag governs
 * (brief §24.8), so the route no longer sits outside the opt-in.
 */
export function requireOrgBackendOnly() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    void reply;

    if (
      request.headers[ORG_ACCESS_TOKEN_HEADER] !== undefined ||
      request.headers[ORG_SUBJECT_ASSERTION_HEADER] !== undefined
    ) {
      throw new AppError('UNAUTHORIZED', 401, 'ACCESS_TOKEN_NOT_ALLOWED');
    }

    await acceptDomainBackendCaller(request, resolveDomainFromRequest(request));
  };
}

export function requireOrgRole(...requiredRoles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    void reply;

    const domain = resolveDomainFromRequest(request);
    const subjectAssertion = resolveOrgSubjectAssertionHeader(request);

    // User-mode credentials are deliberately mutually exclusive. In
    // particular, do not silently choose whichever one happens to verify: a
    // partner BFF that accidentally forwards both must fail closed.
    if (subjectAssertion && request.headers[ORG_ACCESS_TOKEN_HEADER] !== undefined) {
      throw invalidSubjectAssertion();
    }

    // Only genuinely ABSENT headers select backend mode. A present-but-blank
    // one throws inside its resolver rather than reaching here. The three
    // credential modes are one visible choice so that no arm can be reached
    // with a credential the branch above did not establish.
    const token = resolveOrgAccessTokenHeader(request);
    let claims: AccessTokenClaims;
    if (token) {
      claims = await resolveActingUserClaims(token);
    } else if (subjectAssertion) {
      claims = await resolveSubjectAssertionClaims(request, subjectAssertion);
    } else {
      await acceptDomainBackendCaller(request, domain);
      return;
    }
    if (normalizeDomain(claims.domain) !== domain) {
      throw new AppError('FORBIDDEN', 403, 'ACCESS_TOKEN_DOMAIN_MISMATCH');
    }

    const orgId = resolveOrgIdFromParams(request);
    assertRequiredOrgRole(claims, orgId, requiredRoles);

    request.accessTokenClaims = claims;
  };
}
