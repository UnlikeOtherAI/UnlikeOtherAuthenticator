import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { getAdminPrisma } from '../../db/prisma.js';
import { requireSameOriginBrowserRequest } from '../../middleware/same-origin-browser.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { managementSession } from '../../services/org-sso-management.service.js';
import { ownerScimView, setOwnerScimState, issueOwnerScimToken, revokeOwnerScimToken,
  reconcileOwnerScimResource } from '../../services/enterprise-scim-management.service.js';

type OwnerMutation = <T>(request: FastifyRequest, run: (session: Awaited<ReturnType<typeof managementSession>>,
  tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
const Params = z.object({ id: z.string().min(1).max(100) });
export function registerOrganisationAccessScim(app: FastifyInstance, mutation: OwnerMutation,
  limiter: ReturnType<typeof createRateLimiter>) {
  const base = '/auth/organisation-access/sso/connections/:id/scim';
  app.get(base, { preHandler: limiter }, async (request, reply) => {
    const { id } = Params.parse(request.params);
    const cursors = z.object({ identity_cursor: z.string().min(1).max(100).optional(), resource_cursor: z.string().min(1).max(100).optional() }).strict().parse(request.query);
    const session = await managementSession(request.cookies.uoa_org_access);
    return reply.header('Cache-Control', 'no-store').send(await ownerScimView(session, id, getAdminPrisma(), cursors));
  });
  const preHandler = [requireSameOriginBrowserRequest, limiter];
  app.post(`${base}/state`, { preHandler }, async (request) => {
    const { id } = Params.parse(request.params);
    const body = z.object({ revision: z.number().int().positive(), enabled: z.boolean() }).strict().parse(request.body);
    return mutation(request, (session, tx) => setOwnerScimState(session, id, body.revision, body.enabled, tx));
  });
  app.post(`${base}/tokens`, { preHandler }, async (request, reply) => {
    const { id } = Params.parse(request.params); z.object({}).strict().parse(request.body);
    return reply.header('Cache-Control', 'no-store').send(await mutation(request,
      (session, tx) => issueOwnerScimToken(session, id, tx)));
  });
  app.delete(`${base}/tokens/:tokenId`, { preHandler }, async (request) => {
    const { id, tokenId } = Params.extend({ tokenId: z.string().min(1).max(100) }).parse(request.params);
    return mutation(request, (session, tx) => revokeOwnerScimToken(session, id, tokenId, tx));
  });
  app.post(`${base}/reconcile`, { preHandler }, async (request) => {
    const { id } = Params.parse(request.params);
    const body = z.object({ resource_id: z.string().min(1).max(100), external_identity_id: z.string().min(1).max(100),
      version: z.number().int().positive() }).strict().parse(request.body);
    return mutation(request, (session, tx) => reconcileOwnerScimResource(session, id, body, tx));
  });
}
