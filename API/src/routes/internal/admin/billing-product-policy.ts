import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { listProductPolicies, setProductPolicy } from '../../../services/billing-product-policy.service.js';
import { AppError } from '../../../utils/errors.js';

const id = z.string().min(1).max(256);
const body = z.object({ organisation_id: id, source_domain: id,
  billing_timezone: id.default('UTC'), private_at_cost: z.boolean(),
  start_trial: z.boolean().default(false),
  trial_starts_at: z.string().datetime().nullable().optional(),
  trial_ends_at: z.string().datetime().nullable().optional() }).strict();
export function registerAdminProductPolicies(app: FastifyInstance): void {
  const path = '/internal/admin/billing/services/:serviceId/product-policies';
  app.get(path, { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
    const { serviceId } = z.object({ serviceId: id }).parse(request.params);
    reply.header('Cache-Control', 'private, no-store');
    return listProductPolicies(serviceId);
  });
  app.post(path, { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
    const { serviceId } = z.object({ serviceId: id }).parse(request.params);
    const input = body.parse(request.body);
    const claims = request.adminAccessTokenClaims;
    if (!claims) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return setProductPolicy({ serviceId, organisationId: input.organisation_id,
      sourceDomain: input.source_domain, billingTimezone: input.billing_timezone,
      privateAtCost: input.private_at_cost,
      startTrial: input.start_trial,
      trialStartsAt: input.trial_starts_at ? new Date(input.trial_starts_at) : null,
      trialEndsAt: input.trial_ends_at ? new Date(input.trial_ends_at) : null,
      actor: { userId: claims.userId, tokenVersion: claims.tokenVersion } });
  });
}
