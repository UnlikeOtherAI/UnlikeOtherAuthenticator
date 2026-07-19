import type { FastifyInstance } from 'fastify';
import { requireBillingAppKey } from '../../middleware/billing-app-auth.js';
import { getEffectiveTariffSnapshot } from '../../services/billing-entitlement.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

const responseSchema = {
  type: 'object',
  required: ['snapshot', 'payload'],
  properties: {
    snapshot: { type: 'string' },
    payload: { type: 'object', additionalProperties: true },
  },
} as const;

export function registerEffectiveTariffRoute(app: FastifyInstance): void {
  app.post(
    '/billing/v1/effective-tariff',
    {
      preHandler: [requireBillingAppKey],
      schema: { response: { 200: responseSchema } },
    },
    async (request, reply) => {
      const body = BillingSubjectRequestSchema.parse(request.body);
      const credential = request.billingAppKey;
      if (!credential) throw new AppError('UNAUTHORIZED', 401);
      const result = await getEffectiveTariffSnapshot({
        request: {
          product: body.product,
          organisationId: body.organisation_id,
          teamId: body.team_id,
          userId: body.user_id,
        },
        actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
        credential,
      });
      reply.header('Cache-Control', 'private, no-store');
      return result;
    },
  );
}
