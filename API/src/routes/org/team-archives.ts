import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { requireOrgRole } from '../../middleware/org-role-guard.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { beginTeamArchive } from '../../services/team-archive.service.js';
import { AppError } from '../../utils/errors.js';
import { parseDomainContext, parseDomainContextHook, requireVerifiedConfig } from './team-route.shared.js';

export function registerTeamArchiveRoutes(app: FastifyInstance) {
  app.post('/org/organisations/:orgId/teams/:teamId/archive', {
    preValidation: [requireDomainHashAuthForDomainQuery(), configVerifier,
      parseDomainContextHook, requireOrgFeatures, requireOrgRole()],
  }, async (request, reply) => {
    const { orgId, teamId } = z.object({ orgId: z.string().min(1), teamId: z.string().min(1) }).parse(request.params);
    const { request_id } = z.object({ request_id: z.uuid(), deletion_held: z.literal(true) }).strict().parse(request.body);
    const { domain } = parseDomainContext(request);
    if (!request.accessTokenClaims || !request.domainAuthClientId) throw new AppError('UNAUTHORIZED', 401);
    const receipt = await beginTeamArchive({ id: request_id, orgId, teamId, domain,
      domainToken: request.domainAuthClientId, claims: request.accessTokenClaims, config: requireVerifiedConfig(request) });
    return reply.header('Cache-Control', 'no-store').code(202).send(receipt);
  });
}
