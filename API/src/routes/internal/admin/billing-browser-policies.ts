import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { AppError } from '../../../utils/errors.js';
import {
  BrowserPolicyInput,
  listBrowserPolicies,
  publishBrowserPolicy,
} from '../../../services/billing-browser-policy-admin.service.js';

const Params = z.object({ serviceId: z.string().min(1).max(160) }).strict();
const path = '/internal/admin/billing/services/:serviceId/browser-policies';
export function registerInternalAdminBrowserPolicyRoutes(app: FastifyInstance): void {
  const guard = { preHandler: [requireAdminSuperuser] };
  app.get(path, guard, async (request, reply) => {
    const { serviceId } = Params.parse(request.params);
    return reply.header('Cache-Control', 'private, no-store').send(await listBrowserPolicies(serviceId));
  });
  app.post(path, guard, async (request, reply) => {
    const { serviceId } = Params.parse(request.params);
    const claims = request.adminAccessTokenClaims;
    if (!claims) throw new AppError('UNAUTHORIZED', 401);
    const result = await publishBrowserPolicy(serviceId, BrowserPolicyInput.parse(request.body), {
      userId: claims.userId,
      email: claims.email,
      tokenVersion: claims.tokenVersion,
      domain: claims.domain,
    });
    return reply.header('Cache-Control', 'private, no-store').code(201).send(result);
  });
}
