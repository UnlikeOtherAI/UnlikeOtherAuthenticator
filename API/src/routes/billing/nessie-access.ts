import type { FastifyInstance } from 'fastify';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { nessieBillingAccess } from '../../services/billing-nessie-access.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingFinancialSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

export function registerNessieBillingAccessRoute(app: FastifyInstance): void {
  app.post('/billing/v1/organisation/access', { preHandler: [requireBillingLifecycleAppKey] }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    const body = BillingFinancialSubjectRequestSchema.parse(request.body);
    const value = await nessieBillingAccess({ credential: request.billingAppKey,
      actorToken: readBillingActorHeader(request.headers['x-uoa-actor']), endpoint: '/billing/v1/organisation/access',
      request: { product: body.product, organisationId: body.organisation_id, teamId: body.team_id, userId: body.user_id },
    });
    return reply.header('Cache-Control', 'private, no-store').send(value);
  });
}
