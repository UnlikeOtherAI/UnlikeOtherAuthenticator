import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../../utils/errors.js';
import { assertVerifiedDomainMatchesQuery, normalizeDomain } from './domain-context.js';

// Shared schemas/helpers for organisations.ts and organisation-members.ts (split to keep both
// files under the project's 500-line limit; mirrors the teams.ts / team-route.shared.ts pattern).

export const DomainQuerySchema = z
  .object({
    domain: z
      .string()
      .trim()
      .min(1)
      .transform(normalizeDomain),
    config_url: z.string().trim().min(1),
  })
  .strict();

export const ListQuerySchema = DomainQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(200).optional(),
  cursor: z.string().trim().min(1).optional(),
}).strict();

export const MemberStatusQuerySchema = z.enum(['ACTIVE', 'DEACTIVATED', 'REMOVED', 'all']);

export const ListMembersQuerySchema = ListQuerySchema.extend({
  status: MemberStatusQuerySchema.optional(),
}).strict();

export const OrgPathSchema = z.object({
  orgId: z.string().trim().min(1),
});

export const OrgBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Member-initiated invite policy (design §4.7, Phase 4) — owner/admin only; omitted leaves the
  // current setting unchanged. Validated against the allowed vocabulary at the service layer.
  member_invites: z.enum(['allowed', 'admin_approval', 'disabled']).optional(),
  // Workspace icon (design §11.3, gap-fix A Task 3) — owner/admin only (same PUT authorization);
  // omitted leaves the current icon unchanged, `null` clears it. https-only, ≤2048 chars enforced
  // at the service layer (`normalizeIconUrl`) with a generic error otherwise.
  icon_url: z.string().trim().max(2048).nullable().optional(),
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

export function parseDomainContext(request: FastifyRequest) {
  const parsed = DomainQuerySchema.parse(request.query);
  assertVerifiedDomainMatchesQuery(request, parsed.domain);

  return parsed;
}

// Async wrapper for use in Fastify preValidation arrays. Fastify's hook runner only
// continues the chain when a hook returns a Promise or calls next(). parseDomainContext
// returns a plain object (for direct handler use), so we wrap it here.
export async function parseDomainContextHook(request: FastifyRequest): Promise<void> {
  parseDomainContext(request);
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

export function getActorUserId(request: RequestWithClaims): string {
  const userId = request.accessTokenClaims?.userId;
  if (!userId) {
    throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
  }
  return userId;
}

export function getOrgIdFromParams(params: unknown): string {
  const parsed = OrgPathSchema.parse(params ?? {});
  return parsed.orgId;
}

export function getUserIdFromParams(params: unknown): string {
  return MemberUserIdParamSchema.parse(params ?? {}).userId;
}

export function getTransferOwnerId(body: Record<string, unknown>): string {
  const parsed = TransferOwnershipBodySchema.parse(body);
  const id = parsed.newOwnerId ?? parsed.newOwnerUserId;
  if (!id) throw new AppError('BAD_REQUEST', 400, 'MISSING_NEW_OWNER');
  return id;
}

export function keyCreateOrganisationRateLimit(request: FastifyRequest) {
  const domain = parseDomainFromRequest(request);
  const actor = getActorUserId(request as RequestWithClaims);
  return `org:create:${domain}:${actor}`;
}

export function keyAddMemberRateLimit(request: FastifyRequest) {
  const domain = parseDomainFromRequest(request);
  const parsedOrg = OrgPathSchema.parse(request.params);
  return `org:add-member:${domain}:${parsedOrg.orgId}`;
}
