import type { FastifyInstance, FastifyRequest } from 'fastify';

import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { requireOrgRole } from '../../middleware/org-role-guard.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import { parseCreationKey, readOrgCreationStatus, type OrgCreationScope } from '../../services/org-creation-operation.service.js';
import { AppError } from '../../utils/errors.js';
import { getOrgIdFromParams, orgCaller, parseDomainContext, parseDomainContextHook,
  requireVerifiedConfig, tenantUserId } from './organisation-route.shared.js';

export function creationScope(request: FastifyRequest, operation: 'organisation' | 'team'): OrgCreationScope {
  const { domain } = parseDomainContext(request);
  const caller = orgCaller(request);
  const clientDomainId = request.domainAuthClientDomainId;
  if (!clientDomainId) throw new AppError('UNAUTHORIZED', 401);
  return { domain, clientDomainId, operation,
    actorUserId: 'actorUserId' in caller ? caller.actorUserId : null,
    parentId: operation === 'team' ? getOrgIdFromParams(request.params) : null };
}

export function registerOrgCreationStatusRoutes(app: FastifyInstance): void {
  for (const operation of ['organisation', 'team'] as const) {
    const path = operation === 'organisation'
      ? '/org/organisations/creation-status' : '/org/organisations/:orgId/teams/creation-status';
    app.get(path, { preValidation: [requireDomainHashAuthForDomainQuery(), configVerifier,
      parseDomainContextHook, requireOrgFeatures, requireOrgRole()] }, async (request, reply) => {
      const key = parseCreationKey(request.headers['idempotency-key']);
      if (!key) throw new AppError('BAD_REQUEST', 400, 'CREATION_KEY_REQUIRED');
      const scope = creationScope(request, operation);
      setTenantContextFromRequest(request, { orgId: scope.parentId, userId: tenantUserId(request) });
      const result = await request.withTenantTx(tx => readOrgCreationStatus(
        asPrismaClient(tx), scope, key, requireVerifiedConfig(request),
      ));
      return reply.header('Cache-Control', 'private, no-store').send(result);
    });
  }
}
