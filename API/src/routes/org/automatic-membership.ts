import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getAdminPrisma } from '../../db/prisma.js';
import { requireAutomaticMembershipAppKey } from '../../middleware/billing-app-auth.js';
import { AppError } from '../../utils/errors.js';
import { attestAutomaticMembershipDomain, getAutomaticMembershipOperation, grantAutomaticMembership, isAutomaticMembershipAdministrator, listAutomaticMembershipSubjects, listAutomaticMembershipTeams, setAutomaticMembershipFence } from '../../services/automatic-membership.service.js';

const Params = z.object({ orgId: z.string().trim().min(1), teamId: z.string().trim().min(1) });
const Attestation = z.object({ uoaSub: z.string().trim().min(1), org_id: z.string().trim().min(1), domain: z.string().trim().toLowerCase().min(1) }).strict();
const Authorization = z.object({ subject: z.string().trim().min(1), team_ids: z.array(z.string().trim().min(1)).max(100).optional(), scope: z.enum(['organisation', 'organization', 'team']).transform((value) => value === 'organization' ? 'organisation' : value).optional(), team_id: z.string().trim().min(1).optional() }).strict();
const Grant = z.object({ subject: z.string().trim().min(1), domain: z.string().trim().toLowerCase().min(1), idempotency_key: z.string().trim().min(16).max(512), rule_id: z.string().trim().min(1).max(128), rule_generation: z.number().int().positive(), lifecycle_revision: z.number().int().nonnegative().default(0), fence_token: z.string().trim().min(8).max(512) }).strict();
const Fence = z.object({ generation: z.number().int().positive(), lifecycle_revision: z.number().int().nonnegative().default(0), fence_token: z.string().trim().min(8).max(512), active: z.boolean() }).strict();
const Subjects = z.object({ domain: z.string().trim().toLowerCase().min(1), cursor: z.string().trim().min(1).optional(), snapshot_id: z.string().trim().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }).strict();

const credential = (request: { billingAppKey?: unknown }) => {
  if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
  return request.billingAppKey as Parameters<typeof listAutomaticMembershipTeams>[1];
};

export function registerAutomaticMembershipRoutes(app: FastifyInstance): void {
  app.post('/org/automatic-membership/attestations', { preHandler: [requireAutomaticMembershipAppKey] }, async (request, reply) => {
    const body = Attestation.parse(request.body);
    const result = await attestAutomaticMembershipDomain(getAdminPrisma(), credential(request), { orgId: body.org_id, subject: body.uoaSub, domain: body.domain });
    return reply.status(result ? 200 : 204).send(result);
  });
  app.get('/org/automatic-membership/organisations/:orgId/teams', { preHandler: [requireAutomaticMembershipAppKey] }, async (request) => {
    const { orgId } = Params.pick({ orgId: true }).parse(request.params);
    return { teams: await listAutomaticMembershipTeams(getAdminPrisma(), credential(request), orgId) };
  });
  app.post('/org/automatic-membership/organisations/:orgId/authorizations', { preHandler: [requireAutomaticMembershipAppKey] }, async (request) => {
    const { orgId } = Params.pick({ orgId: true }).parse(request.params);
    const body = Authorization.parse(request.body);
    const allowed = await isAutomaticMembershipAdministrator(getAdminPrisma(), credential(request), { orgId, subject: body.subject, teamIds: body.team_ids, scope: body.scope, teamId: body.team_id });
    return {
      allowed,
      // The bridge verifies every echoed binding rather than treating a bare true as authority.
      authorization: allowed ? { subject: body.subject, org_id: orgId, scope: body.scope ?? 'legacy', team_id: body.team_id ?? null, asserted_at: new Date().toISOString() } : null,
    };
  });
  app.get('/org/automatic-membership/organisations/:orgId/subjects', { preHandler: [requireAutomaticMembershipAppKey] }, async (request) => {
    const { orgId } = Params.pick({ orgId: true }).parse(request.params);
    const query = Subjects.parse(request.query);
    return listAutomaticMembershipSubjects(getAdminPrisma(), credential(request), { orgId, domain: query.domain, cursor: query.cursor, snapshotId: query.snapshot_id, limit: query.limit });
  });
  app.post('/org/automatic-membership/organisations/:orgId/teams/:teamId/grants', { preHandler: [requireAutomaticMembershipAppKey] }, async (request) => {
    const { orgId, teamId } = Params.parse(request.params);
    const body = Grant.parse(request.body);
    return grantAutomaticMembership(getAdminPrisma(), credential(request), { orgId, teamId, subject: body.subject, domain: body.domain, idempotencyKey: body.idempotency_key, ruleId: body.rule_id, generation: body.rule_generation, lifecycleRevision: body.lifecycle_revision, fenceToken: body.fence_token });
  });
  app.put('/org/automatic-membership/organisations/:orgId/rules/:ruleId/fence', { preHandler: [requireAutomaticMembershipAppKey] }, async (request) => {
    const { orgId } = Params.pick({ orgId: true }).parse(request.params);
    const ruleId = z.object({ ruleId: z.string().trim().min(1).max(128) }).parse(request.params).ruleId;
    const body = Fence.parse(request.body);
    await setAutomaticMembershipFence(getAdminPrisma(), credential(request), { orgId, ruleId, generation: body.generation, lifecycleRevision: body.lifecycle_revision, fenceToken: body.fence_token, active: body.active });
    return { ok: true };
  });
  app.get('/org/automatic-membership/operations/:operationId', { preHandler: [requireAutomaticMembershipAppKey] }, async (request) => {
    const operationId = z.object({ operationId: z.string().trim().min(1) }).parse(request.params).operationId;
    return getAutomaticMembershipOperation(getAdminPrisma(), credential(request), operationId);
  });
}
