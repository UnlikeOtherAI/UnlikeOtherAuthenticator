import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { seatPlansReadV1JsonSchema, seatCheckoutResultV1JsonSchema } from '@unlikeotherai/billing-statement-protocol';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { readSeatPlans, checkoutSeatPlan } from '../../services/billing-seat-plans.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';
import { readBillingPresentation } from './billing-presentation.js';

export function registerSeatPlanRoutes(app: FastifyInstance) {
  const preHandler = [requireBillingLifecycleAppKey];
  app.post('/billing/v1/seats', { preHandler, schema: { response: { 200: seatPlansReadV1JsonSchema } } }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return readSeatPlans({ request: BillingSubjectRequestSchema.parse(request.body), credential: request.billingAppKey,
      actorToken: readBillingActorHeader(request.headers['x-uoa-actor']), locale: readBillingPresentation(request.headers).locale });
  });
  app.post('/billing/v1/seats/checkout', { preHandler, schema: { response: { 200: seatCheckoutResultV1JsonSchema } } }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    const body = BillingSubjectRequestSchema.extend({ offer_id: z.string().min(1).max(256),
      terms_version: z.literal('company-standard-seat-v1'), accepted: z.literal(true) }).strict().parse(request.body);
    return checkoutSeatPlan({ request: body, credential: request.billingAppKey,
      actorToken: readBillingActorHeader(request.headers['x-uoa-actor']), locale: readBillingPresentation(request.headers).locale });
  });
}
