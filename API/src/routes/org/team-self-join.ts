import type { FastifyInstance } from 'fastify';

import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { requireOrgRole } from '../../middleware/org-role-guard.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import { selfJoinTeam } from '../../services/team.service.js';
import { AppError } from '../../utils/errors.js';
import {
  type RequestWithClaims,
  getActorUserId,
  getOrgIdFromParams,
  getTeamIdFromParams,
  parseDomainContext,
  parseDomainContextHook,
} from './team-route.shared.js';

/**
 * Self-join (Phase 4, design §4.6): `POST /org/organisations/:orgId/teams/:teamId/join`. Any ACTIVE
 * org member may attempt this — the service layer is the actual gate (OPEN_TO_ORG only).
 */
export function registerTeamSelfJoinRoute(app: FastifyInstance): void {
  app.post(
    '/org/organisations/:orgId/teams/:teamId/join',
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
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      const member = await request.withTenantTx((tx) =>
        selfJoinTeam(
          { orgId, teamId, domain, actorUserId, config },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(member);
    },
  );
}
