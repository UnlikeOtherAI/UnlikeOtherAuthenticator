import type { FastifyInstance } from 'fastify';

import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { confirmAuthenticatedDirectBillingServiceAccess } from '../../services/billing-service-access.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

export function registerBillingServiceAccessRoutes(app: FastifyInstance): void {
  app.post(
    '/billing/v1/service-access/confirm',
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: {
        response: {
          204: { type: 'null' },
        },
      },
    },
    async (request, reply) => {
      const body = BillingSubjectRequestSchema.parse(request.body);
      const credential = request.billingAppKey;
      if (!credential) throw new AppError('UNAUTHORIZED', 401);
      await confirmAuthenticatedDirectBillingServiceAccess({
        credential,
        actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
        request: {
          product: body.product,
          organisationId: body.organisation_id,
          teamId: body.team_id,
          userId: body.user_id,
        },
      });
      reply.header('Cache-Control', 'private, no-store');
      return reply.status(204).send();
    },
  );
}
