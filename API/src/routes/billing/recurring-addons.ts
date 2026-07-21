import type { FastifyInstance } from 'fastify';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as ajvFormats from 'ajv-formats';

import {
  BILLING_RECURRING_ADDONS_READ_PATH,
  billingRecurringAddonsV1JsonSchema,
} from '../../contracts/billing-statement-v1.js';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { getBillingRecurringAddons } from '../../services/billing-recurring-addons.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

const validator = new Ajv2020({ allErrors: true, strict: true });
ajvFormats.default.default(validator);
const validateBillingRecurringAddons = validator.compile(billingRecurringAddonsV1JsonSchema);

export function assertBillingRecurringAddonsContract(value: unknown): void {
  if (!validateBillingRecurringAddons(value)) {
    throw new AppError('INTERNAL', 500, 'BILLING_RECURRING_ADDONS_CONTRACT_INVALID');
  }
}

export function registerBillingRecurringAddonsRoute(app: FastifyInstance): void {
  app.post(
    BILLING_RECURRING_ADDONS_READ_PATH,
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: { response: { 200: { type: 'object', additionalProperties: true } } },
    },
    async (request, reply) => {
      const body = BillingSubjectRequestSchema.parse(request.body);
      const credential = request.billingAppKey;
      if (!credential) throw new AppError('UNAUTHORIZED', 401);
      const addons = await getBillingRecurringAddons({
        credential,
        actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
        request: {
          product: body.product,
          organisationId: body.organisation_id,
          teamId: body.team_id,
          userId: body.user_id,
        },
      });
      assertBillingRecurringAddonsContract(addons);
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(addons);
    },
  );
}
