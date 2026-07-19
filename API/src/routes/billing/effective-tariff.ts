import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireBillingAppKey } from '../../middleware/billing-app-auth.js';
import { getEffectiveTariffSnapshot } from '../../services/billing-entitlement.service.js';
import { AppError } from '../../utils/errors.js';

const RequestSchema = z
  .object({
    product: z.string().trim().min(1).max(100),
    organisation_id: z.string().trim().min(1).max(256),
    team_id: z.string().trim().min(1).max(256),
    user_id: z.string().trim().min(1).max(256),
  })
  .strict();

const responseSchema = {
  type: 'object',
  required: ['snapshot', 'payload'],
  properties: {
    snapshot: { type: 'string' },
    payload: { type: 'object', additionalProperties: true },
  },
} as const;

function readActorHeader(value: string | string[] | undefined): string {
  if (value === undefined || Array.isArray(value) || value.includes(',') || !value.trim()) {
    throw new AppError('UNAUTHORIZED', 401, 'MISSING_BILLING_ACTOR');
  }
  return value.trim();
}

export function registerEffectiveTariffRoute(app: FastifyInstance): void {
  app.post(
    '/billing/v1/effective-tariff',
    {
      preHandler: [requireBillingAppKey],
      schema: { response: { 200: responseSchema } },
    },
    async (request, reply) => {
      const body = RequestSchema.parse(request.body);
      const credential = request.billingAppKey;
      if (!credential) throw new AppError('UNAUTHORIZED', 401);
      const result = await getEffectiveTariffSnapshot({
        request: {
          product: body.product,
          organisationId: body.organisation_id,
          teamId: body.team_id,
          userId: body.user_id,
        },
        actorToken: readActorHeader(request.headers['x-uoa-actor']),
        credential,
      });
      reply.header('Cache-Control', 'private, no-store');
      return result;
    },
  );
}
