import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { createStripeCheckoutSession } from '../../services/billing-stripe-checkout.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

const CheckoutRequestSchema = BillingSubjectRequestSchema.extend({
  success_url: z.string().trim().url().max(2048),
  cancel_url: z.string().trim().url().max(2048),
}).strict();

const responseSchema = {
  type: 'object',
  required: ['checkout_session_id', 'checkout_url', 'expires_at', 'tariff'],
  properties: {
    checkout_session_id: { type: 'string' },
    checkout_url: { type: 'string' },
    expires_at: { type: 'string' },
    tariff: { type: 'object', additionalProperties: true },
  },
} as const;

export function registerStripeCheckoutRoute(app: FastifyInstance): void {
  app.post(
    '/billing/v1/stripe/checkout-session',
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: { response: { 201: responseSchema } },
    },
    async (request, reply) => {
      const body = CheckoutRequestSchema.parse(request.body);
      const credential = request.billingAppKey;
      if (!credential) throw new AppError('UNAUTHORIZED', 401);
      const result = await createStripeCheckoutSession({
        request: {
          product: body.product,
          organisationId: body.organisation_id,
          teamId: body.team_id,
          userId: body.user_id,
          successUrl: body.success_url,
          cancelUrl: body.cancel_url,
        },
        actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
        credential,
      });
      reply.header('Cache-Control', 'private, no-store');
      return reply.status(201).send(result);
    },
  );
}
