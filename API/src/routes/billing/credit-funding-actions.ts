import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  BILLING_CREDITS_AUTO_TOP_UP_DISABLE_PATH,
  BILLING_CREDITS_AUTO_TOP_UP_RECOVER_PATH,
  BILLING_CREDITS_AUTO_TOP_UP_SETUP_PATH,
  BILLING_CREDITS_AUTO_TOP_UP_UPDATE_PATH,
  BILLING_CREDITS_TOP_UP_PATH,
} from '../../contracts/billing-statement-v1.js';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import {
  disableBillingCreditAutoTopUp,
  updateBillingCreditAutoTopUp,
} from '../../services/billing-credit-auto-top-up-consent.service.js';
import { recoverBillingCreditAutoTopUp } from '../../services/billing-credit-auto-top-up-recovery.service.js';
import { createBillingCreditAutoTopUpSetup } from '../../services/billing-credit-auto-top-up-setup.service.js';
import type { CreditFundingActionRequest } from '../../services/billing-credit-funding-context.service.js';
import { createBillingCreditTopUpCheckout } from '../../services/billing-credit-top-up.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';
import type { BillingActorEndpoint } from '../../services/billing-actor-audience.service.js';
import type { BillingCustomerLocale } from '../../contracts/billing-statement-v1.js';
import { readBillingPresentation } from './billing-presentation.js';

const OfferRequestSchema = BillingSubjectRequestSchema.extend({
  offer_id: z.string().trim().min(1).max(256),
}).strict();

const OptionRequestSchema = BillingSubjectRequestSchema.extend({
  option_id: z.string().trim().min(1).max(256),
}).strict();

const HostedRedirectResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['redirect_url'],
  properties: {
    redirect_url: { type: 'string', format: 'uri' },
    purchase_id: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

function actionContext(
  request: FastifyRequest,
  body: z.infer<typeof BillingSubjectRequestSchema>,
  endpoint: BillingActorEndpoint,
): {
  request: CreditFundingActionRequest;
  actorToken: string;
  endpoint: BillingActorEndpoint;
  credential: NonNullable<FastifyRequest['billingAppKey']>;
  locale?: BillingCustomerLocale;
} {
  const credential = request.billingAppKey;
  if (!credential) throw new AppError('UNAUTHORIZED', 401);
  const presentation = readBillingPresentation(request.headers);
  return {
    ...(presentation.enabled ? { locale: presentation.locale } : {}),
    credential,
    endpoint,
    actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
    request: {
      product: body.product,
      organisationId: body.organisation_id,
      teamId: body.team_id,
      userId: body.user_id,
    },
  };
}

export function registerBillingCreditFundingActionRoutes(app: FastifyInstance): void {
  app.post(
    BILLING_CREDITS_TOP_UP_PATH,
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: { response: { 200: HostedRedirectResponseSchema } },
    },
    async (request, reply) => {
      const body = OfferRequestSchema.parse(request.body);
      const presentation = readBillingPresentation(request.headers);
      const context = actionContext(request, body, BILLING_CREDITS_TOP_UP_PATH);
      const result = await createBillingCreditTopUpCheckout({
        ...context,
        includePurchaseId: presentation.enabled,
        request: { ...context.request, offerId: body.offer_id },
      });
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(result);
    },
  );

  app.post(
    BILLING_CREDITS_AUTO_TOP_UP_SETUP_PATH,
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: { response: { 200: HostedRedirectResponseSchema } },
    },
    async (request, reply) => {
      const body = OptionRequestSchema.parse(request.body);
      const context = actionContext(request, body, BILLING_CREDITS_AUTO_TOP_UP_SETUP_PATH);
      const result = await createBillingCreditAutoTopUpSetup({
        ...context,
        request: { ...context.request, optionId: body.option_id },
      });
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(result);
    },
  );

  app.post(
    BILLING_CREDITS_AUTO_TOP_UP_UPDATE_PATH,
    { preHandler: [requireBillingLifecycleAppKey] },
    async (request, reply) => {
      const body = OptionRequestSchema.parse(request.body);
      const context = actionContext(request, body, BILLING_CREDITS_AUTO_TOP_UP_UPDATE_PATH);
      await updateBillingCreditAutoTopUp({
        ...context,
        request: { ...context.request, optionId: body.option_id },
      });
      reply.header('Cache-Control', 'private, no-store');
      return reply.status(204).send();
    },
  );

  app.post(
    BILLING_CREDITS_AUTO_TOP_UP_DISABLE_PATH,
    { preHandler: [requireBillingLifecycleAppKey] },
    async (request, reply) => {
      const body = BillingSubjectRequestSchema.parse(request.body);
      await disableBillingCreditAutoTopUp(
        actionContext(request, body, BILLING_CREDITS_AUTO_TOP_UP_DISABLE_PATH),
      );
      reply.header('Cache-Control', 'private, no-store');
      return reply.status(204).send();
    },
  );

  app.post(
    BILLING_CREDITS_AUTO_TOP_UP_RECOVER_PATH,
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: { response: { 200: HostedRedirectResponseSchema } },
    },
    async (request, reply) => {
      const body = BillingSubjectRequestSchema.parse(request.body);
      const result = await recoverBillingCreditAutoTopUp(
        actionContext(request, body, BILLING_CREDITS_AUTO_TOP_UP_RECOVER_PATH),
      );
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(result);
    },
  );
}
