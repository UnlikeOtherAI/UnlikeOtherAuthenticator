import type { FastifyInstance } from 'fastify';

import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import {
  createTeamInvites,
  listTeamInvites,
  resendTeamInvite,
} from '../../services/team-invite.service.js';
import { AppError } from '../../utils/errors.js';

import {
  BulkInviteBodySchema,
  getInviteIdFromParams,
  getOrgIdFromParams,
  getTeamIdFromParams,
  keyInviteTeamRateLimit,
  parseDomainContext,
  parseDomainContextHook,
} from './team-route.shared.js';

export function registerTeamInvitationRoutes(app: FastifyInstance): void {
  app.post(
    '/org/organisations/:orgId/teams/:teamId/invitations',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        createRateLimiter({
          limit: 20,
          windowMs: 60 * 60 * 1000,
          keyBuilder: keyInviteTeamRateLimit,
        }),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) {
        throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');
      }

      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const body = BulkInviteBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId });
      const result = await request.withTenantTx((tx) =>
        createTeamInvites(
          {
            orgId,
            teamId,
            domain,
            config,
            configUrl,
            redirectUrl: body.redirectUrl,
            invitedBy: body.invitedBy,
            invites: body.invites,
          },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(result);
    },
  );

  app.get(
    '/org/organisations/:orgId/teams/:teamId/invitations',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);

      setTenantContextFromRequest(request, { orgId });
      const invites = await request.withTenantTx((tx) =>
        listTeamInvites(
          { orgId, teamId, domain },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(invites);
    },
  );

  app.post(
    '/org/organisations/:orgId/teams/:teamId/invitations/:inviteId/resend',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) {
        throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');
      }

      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const inviteId = getInviteIdFromParams(request.params);

      setTenantContextFromRequest(request, { orgId });
      const invite = await request.withTenantTx((tx) =>
        resendTeamInvite(
          { orgId, teamId, inviteId, domain, config, configUrl },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(invite);
    },
  );
}
