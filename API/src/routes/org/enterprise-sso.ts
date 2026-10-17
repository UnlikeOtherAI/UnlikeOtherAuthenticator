import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAdminPrisma } from '../../db/prisma.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { resolveOrgUserClaims } from '../../middleware/org-role-guard.js';
import { createManagementContinuation } from '../../services/org-sso-management.service.js';
import { enterpriseReadiness } from '../../services/org-sso-policy.service.js';
import { validateSessionAssurance } from '../../services/session-assurance.service.js';
import { AppError } from '../../utils/errors.js';

export function registerOrgEnterpriseRoutes(app: FastifyInstance): void {
  const preHandler = [requireDomainHashAuthForDomainQuery, configVerifier];
  const path = '/org/organisations/:orgId/sso';
  app.get(`${path}/status`, { preHandler }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().min(1) }).parse(request.params);
    const claims = await resolveOrgUserClaims(request);
    const domain = request.config?.domain;
    if (!domain || !claims.org || claims.org.org_id !== orgId || !['owner', 'admin'].includes(claims.org.org_role)) {
      throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_ORG_ROLE');
    }
    const db = getAdminPrisma();
    const [org, policy, connections, readiness] = await Promise.all([
      db.organisation.findUniqueOrThrow({ where: { id: orgId }, select: { ownerId: true } }),
      db.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: { clientDomain: domain, orgId } } }),
      db.orgSsoConnection.findMany({ where: { clientDomain: domain, orgId },
        select: { id: true, displayName: true, protocol: true, status: true }, orderBy: { createdAt: 'asc' } }),
      enterpriseReadiness(domain),
    ]);
    return reply.header('Cache-Control', 'private, no-store').send({ ok: true, version: 1,
      client_domain: domain, org_id: orgId, enforcement: policy?.enforcement ?? 'off',
      connections: connections.map((c) => ({ id: c.id, display_name: c.displayName, protocol: c.protocol, status: c.status })),
      capabilities: { manage_sso: org.ownerId === claims.userId }, readiness });
  });
  app.post(`${path}/management-continuation`, { preHandler }, async (request, reply) => {
    z.object({}).strict().parse(request.body);
    const { orgId } = z.object({ orgId: z.string().min(1) }).parse(request.params);
    const claims = await resolveOrgUserClaims(request);
    const domain = request.config?.domain;
    if (!domain || !claims.assuranceId || claims.org?.org_id !== orgId) {
      throw new AppError('FORBIDDEN', 403, 'INDEPENDENT_REAUTH_REQUIRED');
    }
    return reply.header('Cache-Control', 'no-store').send(await createManagementContinuation({
      userId: claims.userId, credentialEpoch: claims.tokenVersion, clientDomain: domain, orgId,
      assuranceId: claims.assuranceId,
    }));
  });
  app.post('/org/assurance/validate', { preHandler }, async (request, reply) => {
    const body = z.object({ assurance_ref: z.string().min(32).max(256), org_id: z.string().min(1),
      team_id: z.string().min(1).optional() }).strict().parse(request.body);
    const claims = await resolveOrgUserClaims(request);
    const domain = request.config?.domain;
    if (!domain || claims.org?.org_id !== body.org_id || (body.team_id && claims.active?.teamId !== body.team_id)) {
      throw new AppError('FORBIDDEN', 403, 'SSO_TEAM_REAUTH_REQUIRED');
    }
    const proof = await validateSessionAssurance({ reference: body.assurance_ref, userId: claims.userId,
      credentialEpoch: claims.tokenVersion, clientDomain: domain, orgId: body.org_id, teamId: body.team_id });
    return reply.header('Cache-Control', 'no-store').send({ ok: true, active: true,
      assurance_id: proof.id, method: proof.method, expires_at: proof.expiresAt.toISOString(),
      client_domain: proof.clientDomain,
      recheck_by: new Date(Math.min(Date.now() + 1800000, proof.expiresAt.getTime())).toISOString(),
      policy_generation: proof.policyGeneration,
      connection_generation: proof.connectionGeneration, connection_revision: proof.connectionRevision,
      authenticated_at: proof.authenticatedAt?.toISOString() ?? null, observed_at: proof.observedAt.toISOString(),
      ...(proof.connectionId ? { connection_id: proof.connectionId } : {}) });
  });
}
