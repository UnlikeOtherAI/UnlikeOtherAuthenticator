import type { FastifyInstance } from 'fastify';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as ajvFormats from 'ajv-formats';

import {
  BILLING_CREDITS_READ_PATH,
  billingCreditsV1JsonSchema,
} from '../../contracts/billing-statement-v1.js';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { requireOrganisationBillingOverview } from '../../services/billing-legacy-read.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

const validator = new Ajv2020({ allErrors: true, strict: true });
ajvFormats.default.default(validator);
const validateBillingCredits = validator.compile(billingCreditsV1JsonSchema);

export function assertBillingCreditsContract(value: unknown): void {
  if (!validateBillingCredits(value)) {
    throw new AppError('INTERNAL', 500, 'BILLING_CREDITS_CONTRACT_INVALID');
  }
}

export function registerBillingCreditsRoute(app: FastifyInstance): void {
  app.post(
    BILLING_CREDITS_READ_PATH,
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: { response: { 200: { type: 'object', additionalProperties: true } } },
    },
    async (request) => {
      const body = BillingSubjectRequestSchema.parse(request.body);
      const credential = request.billingAppKey;
      if (!credential) throw new AppError('UNAUTHORIZED', 401);
      return requireOrganisationBillingOverview({
        credential,
        actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
        endpoint: BILLING_CREDITS_READ_PATH,
        request: {
          product: body.product,
          organisationId: body.organisation_id,
          teamId: body.team_id,
          userId: body.user_id,
        },
      });
    },
  );
}
