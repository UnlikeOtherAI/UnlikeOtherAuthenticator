import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { productEntitlementV1JsonSchema } from '@unlikeotherai/billing-statement-protocol';
import { requireBillingCommercialWorkerKey, requireBillingEntitlementAppKey } from '../../middleware/billing-app-auth.js';
import { getProductEntitlement } from '../../services/billing-product-entitlement.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

export const CommercialScopeSchema = z.object({ product: z.string().min(1).max(100),
  organisation_id: z.string().min(1).max(256) }).strict();
const backgroundSchema = CommercialScopeSchema.extend({ team_id: z.string().min(1).optional(),
  user_id: z.string().min(1).optional() }).strict();

export function registerProductEntitlementRoutes(app: FastifyInstance): void {
  const { $schema: _dialect, $id: _id, ...response } = productEntitlementV1JsonSchema;
  for (const background of [false, true]) {
    app.post(background ? '/billing/v1/product-entitlement/background' : '/billing/v1/product-entitlement', {
      preHandler: [background ? requireBillingCommercialWorkerKey : requireBillingEntitlementAppKey],
      schema: { response: { 200: response } },
    }, async (request, reply) => {
      const credential = request.billingAppKey;
      if (!credential) throw new AppError('UNAUTHORIZED', 401);
      const body = (background ? backgroundSchema : BillingSubjectRequestSchema).parse(request.body);
      reply.header('Cache-Control', 'private, no-store');
      return getProductEntitlement({ request: body, credential,
        ...(background ? {} : { actorToken: readBillingActorHeader(request.headers['x-uoa-actor']) }) });
    });
  }
  app.get('/schemas/product-entitlement-v1.json', async () => productEntitlementV1JsonSchema);
}
