import type { FastifyInstance } from 'fastify';

import {
  BILLING_CREDIT_FUNDING_REQUEST_PATH,
  billingCreditFundingRequestV1JsonSchema,
} from '../../contracts/billing-statement-v1.js';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { createBillingCreditFundingRequest } from '../../services/billing-credit-funding-request.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';
import { readBillingPresentation } from './billing-presentation.js';

export function registerBillingCreditFundingRequestRoute(app: FastifyInstance): void {
  app.post(
    BILLING_CREDIT_FUNDING_REQUEST_PATH,
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: { response: { 200: billingCreditFundingRequestV1JsonSchema } },
    },
    async (request, reply) => {
      const body = BillingSubjectRequestSchema.parse(request.body);
      const presentation = readBillingPresentation(request.headers);
      if (!presentation.enabled) {
        throw new AppError('BAD_REQUEST', 400, 'BILLING_PRESENTATION_REQUIRED');
      }
      const credential = request.billingAppKey;
      if (!credential) throw new AppError('UNAUTHORIZED', 401);
      const result = await createBillingCreditFundingRequest({
        credential,
        endpoint: BILLING_CREDIT_FUNDING_REQUEST_PATH,
        actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
        request: {
          product: body.product,
          organisationId: body.organisation_id,
          teamId: body.team_id,
          userId: body.user_id,
        },
      });
      return reply.header('Cache-Control', 'private, no-store').send(result);
    },
  );
}
