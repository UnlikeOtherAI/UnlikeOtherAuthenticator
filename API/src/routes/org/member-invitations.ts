import type { FastifyInstance } from 'fastify';

import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { requireOrgRole } from '../../middleware/org-role-guard.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import {
  listInvitationTargets,
  listPendingInvitations,
} from '../../services/team-invite.service.js';
import {
  getOrgIdFromParams,
  orgCaller,
  parseMemberInvitationRosterQuery,
  parseDomainContextHook,
  requireVerifiedConfig,
  tenantUserId,
} from './organisation-route.shared.js';

/**
 * Roster data for the Members settings surface. It intentionally does not
 * overlap `/invitations?approval=pending`, which is an owner-only approval
 * work queue rather than the actionable team invitations a person has sent.
 */
export function registerMemberInvitationRoutes(app: FastifyInstance): void {
  app.get(
    '/org/organisations/:orgId/member-invitation-targets',
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
      const { domain, limit, cursor, direction } = parseMemberInvitationRosterQuery(request);
      const orgId = getOrgIdFromParams(request.params);
      const config = requireVerifiedConfig(request);

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      const result = await request.withTenantTx((tx) =>
        listInvitationTargets(
          { orgId, domain, ...orgCaller(request), config, limit, cursor, direction },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(result);
    },
  );

  app.get(
    '/org/organisations/:orgId/member-invitations',
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
      const { domain, limit, cursor, direction } = parseMemberInvitationRosterQuery(request);
      const orgId = getOrgIdFromParams(request.params);
      const config = requireVerifiedConfig(request);

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      const result = await request.withTenantTx((tx) =>
        listPendingInvitations(
          { orgId, domain, ...orgCaller(request), config, limit, cursor, direction },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(result);
    },
  );
}
