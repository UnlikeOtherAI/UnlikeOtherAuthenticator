import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ClientConfig } from '../../services/config.service.js';
import type { OrgActorProvenance } from '../../services/org-audit-log.service.js';
import { AppError } from '../../utils/errors.js';
import { assertVerifiedDomainMatchesQuery, normalizeDomain } from './domain-context.js';

// Shared schemas/helpers for organisations.ts and organisation-members.ts (split to keep both
// files under the project's 500-line limit; mirrors the teams.ts / team-route.shared.ts pattern).

export const DomainQuerySchema = z
  .object({
    domain: z.string().trim().min(1).transform(normalizeDomain),
    config_url: z.string().trim().min(1),
  })
  .strict();

export const ListQuerySchema = DomainQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(200).optional(),
  cursor: z.string().trim().min(1).optional(),
}).strict();

export const MemberStatusQuerySchema = z.enum(['ACTIVE', 'DEACTIVATED', 'REMOVED', 'all']);

export const ListMembersQuerySchema = ListQuerySchema.extend({
  direction: z.enum(['forward', 'backward']).optional(),
  status: MemberStatusQuerySchema.optional(),
}).strict();

export const MemberInvitationRosterQuerySchema = ListQuerySchema.extend({
  direction: z.enum(['forward', 'backward']).optional(),
}).strict();

export const OrgPathSchema = z.object({
  orgId: z.string().trim().min(1),
});

export const OrgBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Member-initiated invite policy (design §4.7, Phase 4) — owner/admin only; omitted leaves the
  // current setting unchanged. Validated against the allowed vocabulary at the service layer.
  member_invites: z.enum(['allowed', 'admin_approval', 'disabled']).optional(),
  // Team icon (design §11.3, gap-fix A Task 3) — owner/admin only (same PUT authorization);
  // omitted leaves the current icon unchanged, `null` clears it. https-only, ≤2048 chars enforced
  // at the service layer (`normalizeIconUrl`) with a generic error otherwise.
  icon_url: z.string().trim().max(2048).nullable().optional(),
  // The tenant's DNS label. Omitted leaves the address untouched — a rename
  // must never move it — so this is the only way to change it. 2..63; shape and
  // reserved words are enforced in the service.
  slug: z.string().trim().min(2).max(63).optional(),
});

/**
 * `POST /org/organisations` body.
 *
 * The new organisation needs an owner. On the user path that is the acting user
 * and the body must NOT name one. In backend mode there is no acting user, so
 * the caller states the owner explicitly — the same shape `.../members` already
 * uses for its `userId` target. Requiring exactly one of the two makes it
 * impossible to send an ambiguous request.
 */
export const CreateOrgBodySchema = OrgBodySchema.extend({
  owner_user_id: z.string().trim().min(1).optional(),
});

export const AddMemberBodySchema = z.object({
  userId: z.string().trim().min(1),
  role: z.string().trim().min(1).optional(),
});

export const SetRoleBodySchema = z.object({
  role: z.string().trim().min(1),
});

export const MemberUserIdParamSchema = z.object({
  userId: z.string().trim().min(1),
});

export const TransferOwnershipBodySchema = z
  .object({
    newOwnerId: z.string().trim().min(1).optional(),
    newOwnerUserId: z.string().trim().min(1).optional(),
    // The role the outgoing owner is left with. Bounded like every other role string (config
    // `org_roles` entries are 1–50 chars); the service validates it against this domain's actual
    // vocabulary, since only the verified config knows what those are.
    previousOwnerRole: z.string().trim().min(1).max(50).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.newOwnerId && !value.newOwnerUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'newOwnerId or newOwnerUserId is required.',
        path: ['newOwnerId'],
      });
    }
    if (value.newOwnerId && value.newOwnerUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either newOwnerId or newOwnerUserId.',
        path: ['newOwnerUserId'],
      });
    }
  });

export type RequestWithClaims = FastifyRequest & {
  accessTokenClaims?: {
    userId: string;
    role?: 'superuser' | 'user';
    org?: {
      org_id: string;
    };
  };
};

/**
 * The verified client config for this request.
 *
 * Every `/org/*` route runs `configVerifier`, so the config is always there in practice; this
 * refuses rather than assumes, because the org/team services now resolve the domain's configured
 * role vocabulary and `role_grants` out of it and must never silently fall back to a default table
 * the domain did not write.
 */
export function requireVerifiedConfig(request: FastifyRequest): ClientConfig {
  const config = request.config;
  if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');
  return config;
}

export function parseDomainContext(request: FastifyRequest) {
  const parsed = DomainQuerySchema.parse(request.query);
  assertVerifiedDomainMatchesQuery(request, parsed.domain);

  return parsed;
}

// preValidation runs before the handler's own strict query parse, so this hook
// must tolerate route-specific keys (limit, cursor, status) that the strict
// DomainQuerySchema would reject — brief §24.11 documents `?limit=&cursor=` on
// every list endpoint. Validate only the shared domain context here; each
// handler still strict-parses its full query schema.
const DomainContextHookSchema = DomainQuerySchema.passthrough();

export async function parseDomainContextHook(request: FastifyRequest): Promise<void> {
  const parsed = DomainContextHookSchema.parse(request.query);
  assertVerifiedDomainMatchesQuery(request, parsed.domain);
}

export function parseDomainFromRequest(request: FastifyRequest): string {
  const parsed = DomainQuerySchema.parse(request.query);
  assertVerifiedDomainMatchesQuery(request, parsed.domain);
  return parsed.domain;
}

export function parseLimitCursor(request: FastifyRequest) {
  const parsed = ListQuerySchema.parse(request.query);
  assertVerifiedDomainMatchesQuery(request, parsed.domain);
  return parsed;
}

export function parseMembersListQuery(request: FastifyRequest) {
  const parsed = ListMembersQuerySchema.parse(request.query);
  assertVerifiedDomainMatchesQuery(request, parsed.domain);
  return parsed;
}

export function parseMemberInvitationRosterQuery(request: FastifyRequest) {
  const parsed = MemberInvitationRosterQuerySchema.parse(request.query);
  assertVerifiedDomainMatchesQuery(request, parsed.domain);
  return parsed;
}

/**
 * The acting user. Use this only on routes that are meaningless without one
 * (`GET /org/me`, team self-join) — it throws 401 in backend mode by design.
 */
export function getActorUserId(request: RequestWithClaims): string {
  const userId = request.accessTokenClaims?.userId;
  if (!userId) {
    throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
  }
  return userId;
}

/**
 * Who is making this `/org/*` call, in the exact shape the service layer takes.
 *
 * Returns one of two things and never anything in between:
 *
 *   - `{ actorUserId }` — a signed-in user is acting. Unchanged behaviour.
 *   - `{ actor }` — the domain backend is acting: `requireOrgRole` accepted the
 *     request on the domain pairing alone. There is deliberately NO acting user.
 *
 * Spread it straight into the service params (`...orgCaller(request)`) so a call
 * site cannot pass one half without the other. `resolveOrgActor` in the service
 * rejects params carrying neither with a 500, so a dropped spread is a loud
 * failure rather than a silent authorization bypass.
 *
 * The `{ actor }` branch is reachable ONLY through `request.orgBackendCaller`,
 * which `requireOrgRole` is the only writer of.
 */
export function orgCaller(
  request: FastifyRequest,
): { actorUserId: string } | { actor: OrgActorProvenance } {
  const userId = request.accessTokenClaims?.userId;
  if (userId) return { actorUserId: userId };

  const backend = request.orgBackendCaller;
  if (backend) return { actor: { via: 'domain_backend', sourceDomain: backend.domain } };

  throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
}

/**
 * The acting user's id for `setTenantContextFromRequest`, or `null` in backend
 * mode.
 *
 * `app.user_id` is only ever an ADDITIVE branch in the RLS policies (owner-of /
 * member-of predicates); every `/org/*` table is reachable through `app.org_id`
 * alone, which these routes always set. Leaving it empty therefore narrows what
 * the transaction can see, never widens it.
 */
export function tenantUserId(request: FastifyRequest): string | null {
  return request.accessTokenClaims?.userId ?? null;
}

/**
 * Provenance of the domain backend that made this call itself, or `undefined`
 * when a signed-in user is acting.
 *
 * Pair this with `getActorUserId` wherever a mutation writes an org audit row, so
 * the row records WHO acted as well as FOR WHOM. `requireOrgRole` populates
 * `request.orgBackendCaller` only when it accepted the request on the domain
 * pairing alone.
 */
export function getActorProvenance(request: FastifyRequest): OrgActorProvenance | undefined {
  const backend = request.orgBackendCaller;
  return backend ? { via: 'domain_backend', sourceDomain: backend.domain } : undefined;
}

export function getOrgIdFromParams(params: unknown): string {
  const parsed = OrgPathSchema.parse(params ?? {});
  return parsed.orgId;
}

export function getUserIdFromParams(params: unknown): string {
  return MemberUserIdParamSchema.parse(params ?? {}).userId;
}

export function parseTransferOwnershipBody(body: Record<string, unknown>): {
  newOwnerId: string;
  previousOwnerRole?: string;
} {
  const parsed = TransferOwnershipBodySchema.parse(body);
  const id = parsed.newOwnerId ?? parsed.newOwnerUserId;
  if (!id) throw new AppError('BAD_REQUEST', 400, 'MISSING_NEW_OWNER');
  return { newOwnerId: id, previousOwnerRole: parsed.previousOwnerRole };
}

export function keyCreateOrganisationRateLimit(request: FastifyRequest) {
  const domain = parseDomainFromRequest(request);
  // In backend mode there is no acting user to key on. One shared per-domain
  // bucket is correct there: the backend IS the single caller, and keying on the
  // requested owner would let it mint an unlimited number of orgs by naming a
  // different owner each time.
  const caller = orgCaller(request);
  const actor = 'actorUserId' in caller ? caller.actorUserId : 'backend';
  return `org:create:${domain}:${actor}`;
}

export function keyAddMemberRateLimit(request: FastifyRequest) {
  const domain = parseDomainFromRequest(request);
  const parsedOrg = OrgPathSchema.parse(request.params);
  return `org:add-member:${domain}:${parsedOrg.orgId}`;
}
