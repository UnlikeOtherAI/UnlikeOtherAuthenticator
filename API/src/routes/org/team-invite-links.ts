import type { FastifyInstance } from 'fastify';

import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { requireOrgRole } from '../../middleware/org-role-guard.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import {
  createTeamInviteLink,
  listTeamInviteLinks,
  revokeTeamInviteLink,
} from '../../services/team-invite-link.service.js';
import { AppError } from '../../utils/errors.js';
import {
  InviteLinkCreateBodySchema,
  type RequestWithClaims,
  getActorUserId,
  getLinkIdFromParams,
  getOrgIdFromParams,
  getTeamIdFromParams,
  keyInviteLinkRateLimit,
  parseDomainContext,
  parseDomainContextHook,
} from './team-route.shared.js';

/**
 * Team invite-link management (Phase 5, design §4.7). Same dual-auth preValidation chain as the
 * other `/org/.../teams/...` routes — membership-only at the route (`requireOrgRole()`), with the
 * owner/admin-or-team-manager tier enforced inside the service layer (mirrors
 * `createMemberInvite`'s permission matrix).
 */
export function registerTeamInviteLinkRoutes(app: FastifyInstance): void {
  app.post(
    '/org/organisations/:orgId/teams/:teamId/invite-links',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
        createRateLimiter({
          limit: 20,
          windowMs: 60 * 60 * 1000,
          keyBuilder: keyInviteLinkRateLimit,
        }),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);
      const body = InviteLinkCreateBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      const result = await request.withTenantTx((tx) =>
        createTeamInviteLink(
          {
            orgId,
            teamId,
            domain,
            actorUserId,
            roleToAssign: body.roleToAssign,
            maxUses: body.maxUses,
            expiresInDays: body.expiresInDays,
            config,
          },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(result);
    },
  );

  app.get(
    '/org/organisations/:orgId/teams/:teamId/invite-links',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      const result = await request.withTenantTx((tx) =>
        listTeamInviteLinks(
          { orgId, teamId, domain, actorUserId },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(result);
    },
  );

  app.delete(
    '/org/organisations/:orgId/teams/:teamId/invite-links/:linkId',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const linkId = getLinkIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      const result = await request.withTenantTx((tx) =>
        revokeTeamInviteLink(
          { orgId, teamId, linkId, domain, actorUserId },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(result);
    },
  );
}
