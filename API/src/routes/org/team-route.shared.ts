import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../../utils/errors.js';
import { assertVerifiedDomainMatchesQuery, normalizeDomain } from './domain-context.js';

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

export const OrgPathSchema = z.object({
  orgId: z.string().trim().min(1),
});

export const TeamPathSchema = z.object({
  orgId: z.string().trim().min(1),
  teamId: z.string().trim().min(1),
});

export const TeamBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

export const TeamUpdateBodySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  slug: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

export const AddTeamMemberBodySchema = z.object({
  userId: z.string().trim().min(1),
  teamRole: z.string().trim().min(1).optional(),
});

export const ChangeTeamMemberRoleBodySchema = z.object({
  teamRole: z.string().trim().min(1),
});

const TeamInviteeSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().max(120).optional(),
  teamRole: z.string().trim().min(1).optional(),
});

export const BulkInviteBodySchema = z.object({
  redirectUrl: z.string().trim().min(1).optional(),
  invitedBy: z
    .object({
      userId: z.string().trim().min(1).optional(),
      name: z.string().trim().max(120).optional(),
      email: z.string().trim().toLowerCase().email().optional(),
    })
    .optional(),
  invites: z
    .array(TeamInviteeSchema)
    .min(1)
    .max(200)
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      for (let i = 0; i < items.length; i += 1) {
        const email = items[i].email;
        if (seen.has(email)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Duplicate invite email',
            path: [i, 'email'],
          });
        }
        seen.add(email);
      }
    }),
});

export type RequestWithClaims = FastifyRequest & {
  accessTokenClaims?: {
    userId: string;
  };
};

export function parseDomainContext(request: FastifyRequest) {
  const parsed = DomainQuerySchema.parse(request.query);
  assertVerifiedDomainMatchesQuery(request, parsed.domain);

  return parsed;
}

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

export function getTeamIdFromParams(params: unknown): string {
  const parsed = TeamPathSchema.parse(params ?? {});
  return parsed.teamId;
}

export function getMemberUserIdFromParams(params: unknown): string {
  const parsed = z.object({ userId: z.string().trim().min(1) }).parse(params ?? {});
  return parsed.userId;
}

export function getInviteIdFromParams(params: unknown): string {
  const parsed = z.object({ inviteId: z.string().trim().min(1) }).parse(params ?? {});
  return parsed.inviteId;
}

export function keyCreateTeamRateLimit(request: FastifyRequest) {
  const domain = parseDomainFromRequest(request);
  const orgId = getOrgIdFromParams(request.params);
  return `org:create-team:${domain}:${orgId}`;
}

export function keyInviteTeamRateLimit(request: FastifyRequest) {
  const domain = parseDomainFromRequest(request);
  const orgId = getOrgIdFromParams(request.params);
  const teamId = getTeamIdFromParams(request.params);
  return `org:invite-team:${domain}:${orgId}:${teamId}`;
}
