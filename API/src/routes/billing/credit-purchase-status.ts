import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BILLING_CREDIT_PURCHASE_STATUS_PATH, billingCreditPurchaseStatusV1JsonSchema } from '../../contracts/billing-statement-v1.js';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { getBillingCreditPurchaseStatus } from '../../services/billing-credit-purchase-status.service.js';
import { AppError } from '../../utils/errors.js';
import { readBillingPresentation } from './billing-presentation.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

const RequestSchema = BillingSubjectRequestSchema.extend({ purchase_id: z.string().min(1).max(256) }).strict();

export function registerBillingCreditPurchaseStatusRoute(app: FastifyInstance): void {
  app.post(BILLING_CREDIT_PURCHASE_STATUS_PATH, {
    preHandler: [requireBillingLifecycleAppKey],
    schema: { response: { 200: billingCreditPurchaseStatusV1JsonSchema } },
  }, async (request, reply) => {
    const body = RequestSchema.parse(request.body);
    const presentation = readBillingPresentation(request.headers);
    const credential = request.billingAppKey;
    if (!credential) throw new AppError('UNAUTHORIZED', 401);
    const result = await getBillingCreditPurchaseStatus({
      credential, endpoint: BILLING_CREDIT_PURCHASE_STATUS_PATH,
      actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
      locale: presentation.locale,
      presentationEnabled: presentation.enabled,
      request: {
        product: body.product, organisationId: body.organisation_id,
        teamId: body.team_id, userId: body.user_id, purchaseId: body.purchase_id,
      },
    });
    return reply.header('Cache-Control', 'private, no-store').send(result);
  });
}
