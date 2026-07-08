import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { requireOrgRole } from '../../middleware/org-role-guard.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import {
  approveInvite,
  denyInvite,
  listPendingApprovalInvites,
} from '../../services/team-invite.service.js';
import { AppError } from '../../utils/errors.js';
import { assertVerifiedDomainMatchesQuery, normalizeDomain } from './domain-context.js';
import { type RequestWithClaims, getActorUserId, getOrgIdFromParams } from './organisation-route.shared.js';

const ListQuerySchema = z
  .object({
    domain: z.string().trim().min(1).transform(normalizeDomain),
    config_url: z.string().trim().min(1),
    approval: z.string().trim().min(1).optional(),
  })
  .strict();

const DomainQuerySchema = z
  .object({
    domain: z.string().trim().min(1).transform(normalizeDomain),
    config_url: z.string().trim().min(1),
  })
  .strict();

const InviteIdParamSchema = z.object({
  orgId: z.string().trim().min(1),
  inviteId: z.string().trim().min(1),
});

function parseListQuery(request: FastifyRequest) {
  const parsed = ListQuerySchema.parse(request.query);
  assertVerifiedDomainMatchesQuery(request, parsed.domain);
  return parsed;
}

function parseDomainQuery(request: FastifyRequest) {
  const parsed = DomainQuerySchema.parse(request.query);
  assertVerifiedDomainMatchesQuery(request, parsed.domain);
  return parsed;
}

async function parseDomainQueryHook(request: FastifyRequest): Promise<void> {
  parseDomainQuery(request);
}

/**
 * Member-invite approval workflow (Phase 4 Task 4, design §4.7). Org-level, owner/admin only —
 * `requireOrgRole('owner', 'admin')` on every route here.
 */
export function registerInvitationApprovalRoutes(app: FastifyInstance): void {
  app.get(
    '/org/organisations/:orgId/invitations',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainQueryHook,
        requireOrgFeatures,
        requireOrgRole('owner', 'admin'),
      ],
    },
    async (request, reply) => {
      const { domain, approval } = parseListQuery(request);
      if (approval !== 'pending') {
        throw new AppError('BAD_REQUEST', 400);
      }

      const orgId = getOrgIdFromParams(request.params);
      setTenantContextFromRequest(request, { orgId });
      const result = await request.withTenantTx((tx) =>
        listPendingApprovalInvites({ orgId, domain }, { prisma: asPrismaClient(tx) }),
      );

      reply.status(200).send(result);
    },
  );

  app.post(
    '/org/organisations/:orgId/invitations/:inviteId/approve',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainQueryHook,
        requireOrgFeatures,
        requireOrgRole('owner', 'admin'),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainQuery(request);
      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const { orgId, inviteId } = InviteIdParamSchema.parse(request.params);
      const reviewerUserId = getActorUserId(request as RequestWithClaims);

      setTenantContextFromRequest(request, { orgId, userId: reviewerUserId });
      const invite = await request.withTenantTx((tx) =>
        approveInvite(
          { orgId, domain, inviteId, config, configUrl, reviewerUserId },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(invite);
    },
  );

  app.post(
    '/org/organisations/:orgId/invitations/:inviteId/deny',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainQueryHook,
        requireOrgFeatures,
        requireOrgRole('owner', 'admin'),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainQuery(request);
      const { orgId, inviteId } = InviteIdParamSchema.parse(request.params);
      const reviewerUserId = getActorUserId(request as RequestWithClaims);

      setTenantContextFromRequest(request, { orgId, userId: reviewerUserId });
      const invite = await request.withTenantTx((tx) =>
        denyInvite({ orgId, domain, inviteId, reviewerUserId }, { prisma: asPrismaClient(tx) }),
      );

      reply.status(200).send(invite);
    },
  );
}
