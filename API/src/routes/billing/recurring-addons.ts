import type { FastifyInstance } from 'fastify';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as ajvFormats from 'ajv-formats';
import { z } from 'zod';

import {
  BILLING_RECURRING_ADDONS_CANCELLATION_CONFIRM_PATH,
  BILLING_RECURRING_ADDONS_CANCELLATION_PREVIEW_PATH,
  BILLING_RECURRING_ADDONS_CHECKOUT_PATH,
  BILLING_RECURRING_ADDONS_READ_PATH,
  billingHostedRedirectResponseJsonSchema,
  billingRecurringAddonCancellationConfirmationV1JsonSchema,
  billingRecurringAddonCancellationPreviewV1JsonSchema,
  billingRecurringAddonsV1JsonSchema,
} from '../../contracts/billing-statement-v1.js';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { confirmRecurringAddonCancellation } from '../../services/billing-recurring-addon-cancellation-confirm.service.js';
import { createRecurringAddonCancellationPreview } from '../../services/billing-recurring-addon-cancellation-preview.service.js';
import { createRecurringAddonCheckout } from '../../services/billing-recurring-addon-checkout.service.js';
import { getBillingRecurringAddons } from '../../services/billing-recurring-addons.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

const validator = new Ajv2020({ allErrors: true, strict: true });
ajvFormats.default.default(validator);
const validateBillingRecurringAddons = validator.compile(billingRecurringAddonsV1JsonSchema);
const validateHostedRedirect = validator.compile(billingHostedRedirectResponseJsonSchema);
const validateCancellationPreview = validator.compile(
  billingRecurringAddonCancellationPreviewV1JsonSchema,
);
const validateCancellationConfirmation = validator.compile(
  billingRecurringAddonCancellationConfirmationV1JsonSchema,
);

const CheckoutRequestSchema = BillingSubjectRequestSchema.extend({
  offer_id: z.string().trim().min(1).max(256),
}).strict();
const CancellationPreviewRequestSchema = BillingSubjectRequestSchema.extend({
  subscription_id: z.string().trim().min(1).max(256),
}).strict();
const CancellationConfirmRequestSchema = BillingSubjectRequestSchema.extend({
  preview_token: z.string().trim().min(32).max(256),
  idempotency_key: z.string().trim().min(16).max(200),
  choice: z.literal('cancel_addon'),
}).strict();

function assertContract(validate: (value: unknown) => boolean, value: unknown): void {
  if (!validate(value)) {
    throw new AppError('INTERNAL', 500, 'BILLING_RECURRING_ADDON_CONTRACT_INVALID');
  }
}

export function assertBillingRecurringAddonsContract(value: unknown): void {
  assertContract(validateBillingRecurringAddons, value);
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

  app.post(
    BILLING_RECURRING_ADDONS_CHECKOUT_PATH,
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: { response: { 200: billingHostedRedirectResponseJsonSchema } },
    },
    async (request, reply) => {
      const body = CheckoutRequestSchema.parse(request.body);
      const credential = request.billingAppKey;
      if (!credential) throw new AppError('UNAUTHORIZED', 401);
      const result = await createRecurringAddonCheckout({
        credential,
        actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
        request: {
          product: body.product,
          organisationId: body.organisation_id,
          teamId: body.team_id,
          userId: body.user_id,
          offerId: body.offer_id,
        },
      });
      assertContract(validateHostedRedirect, result);
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(result);
    },
  );

  app.post(
    BILLING_RECURRING_ADDONS_CANCELLATION_PREVIEW_PATH,
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: { response: { 200: billingRecurringAddonCancellationPreviewV1JsonSchema } },
    },
    async (request, reply) => {
      const body = CancellationPreviewRequestSchema.parse(request.body);
      const credential = request.billingAppKey;
      if (!credential) throw new AppError('UNAUTHORIZED', 401);
      const result = await createRecurringAddonCancellationPreview({
        credential,
        actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
        request: {
          product: body.product,
          organisationId: body.organisation_id,
          teamId: body.team_id,
          userId: body.user_id,
          subscriptionId: body.subscription_id,
        },
      });
      assertContract(validateCancellationPreview, result);
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(result);
    },
  );

  app.post(
    BILLING_RECURRING_ADDONS_CANCELLATION_CONFIRM_PATH,
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: { response: { 200: billingRecurringAddonCancellationConfirmationV1JsonSchema } },
    },
    async (request, reply) => {
      const body = CancellationConfirmRequestSchema.parse(request.body);
      const credential = request.billingAppKey;
      if (!credential) throw new AppError('UNAUTHORIZED', 401);
      const result = await confirmRecurringAddonCancellation({
        credential,
        actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
        request: {
          product: body.product,
          organisationId: body.organisation_id,
          teamId: body.team_id,
          userId: body.user_id,
          previewToken: body.preview_token,
          idempotencyKey: body.idempotency_key,
          choice: body.choice,
        },
      });
      assertContract(validateCancellationConfirmation, result);
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(result);
    },
  );
}
