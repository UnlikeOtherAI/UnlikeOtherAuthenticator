import type { FastifyInstance } from 'fastify';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as ajvFormats from 'ajv-formats';

import {
  BILLING_CREDITS_READ_PATH,
  BILLING_CREDITS_PROTOCOL_HEADER,
  BILLING_CREDITS_PROTOCOL_VERSION,
  billingCreditsV1JsonSchema,
} from '../../contracts/billing-statement-v1.js';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { getBillingCredits } from '../../services/billing-credits.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';
import { readBillingPresentation } from './billing-presentation.js';

const validator = new Ajv2020({ allErrors: true, strict: true });
ajvFormats.default.default(validator);
const validateBillingCredits = validator.compile(billingCreditsV1JsonSchema);

export function assertBillingCreditsContract(value: unknown): void {
  if (!validateBillingCredits(value)) {
    throw new AppError('INTERNAL', 500, 'BILLING_CREDITS_CONTRACT_INVALID');
  }
}

// 2.0.0 added billing_status, 2.1.0 offers in the billing region's currency, 2.2.0
// reload options in it, and 2.3.0 the balance, entries and price rate valued in it.
const CREDITS_PROTOCOL_VERSIONS: string[] = ['2.0.0', '2.1.0', '2.2.0', BILLING_CREDITS_PROTOCOL_VERSION];

export function registerBillingCreditsRoute(app: FastifyInstance): void {
  app.post(
    BILLING_CREDITS_READ_PATH,
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: { response: { 200: { type: 'object', additionalProperties: true } } },
    },
    async (request, reply) => {
      const body = BillingSubjectRequestSchema.parse(request.body);
      const presentation = readBillingPresentation(request.headers);
      const credential = request.billingAppKey;
      if (!credential) throw new AppError('UNAUTHORIZED', 401);
      // Each credits protocol version includes everything before it.
      const level = CREDITS_PROTOCOL_VERSIONS.indexOf(String(request.headers[BILLING_CREDITS_PROTOCOL_HEADER] ?? ''));
      const credits = await getBillingCredits({
        ...(presentation.enabled ? { locale: presentation.locale } : {}),
        credential,
        actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
        endpoint: BILLING_CREDITS_READ_PATH,
        supportsBillingStatus: level >= 0,
        supportsPurchaseCurrency: level >= 1,
        supportsReloadCurrency: level >= 2,
        supportsRegionValue: level >= 3,
        log: request.log,
        request: {
          product: body.product,
          organisationId: body.organisation_id,
          teamId: body.team_id,
          userId: body.user_id,
        },
      });
      assertBillingCreditsContract(credits);
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(credits);
    },
  );
}
