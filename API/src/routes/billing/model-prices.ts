import type { FastifyInstance } from 'fastify';
import { BillingModelPricesRequestSchema, BillingModelPricesResponseSchema } from '../../contracts/billing-model-prices.js';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { getModelDisplayPrices } from '../../services/billing-model-prices.service.js';
import { AppError } from '../../utils/errors.js';
import { readBillingActorHeader } from './billing-request.js';

export function registerModelPriceRoutes(app: FastifyInstance): void {
  app.post('/billing/v1/model-prices', { bodyLimit: 256 * 1024,
    preHandler: [requireBillingLifecycleAppKey] }, async (request, reply) => {
    const credential = request.billingAppKey;
    if (!credential) throw new AppError('UNAUTHORIZED', 401);
    const result = await getModelDisplayPrices({ request: BillingModelPricesRequestSchema.parse(request.body),
      credential, actorToken: readBillingActorHeader(request.headers['x-uoa-actor']) });
    reply.header('Cache-Control', 'private, no-store');
    return BillingModelPricesResponseSchema.parse(result);
  });
}
