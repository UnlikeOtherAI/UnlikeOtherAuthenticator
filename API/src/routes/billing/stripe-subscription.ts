import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import {
  createStripePortalSession,
  getStripeSubscriptionSummary,
  type BillingSubscriptionRequest,
} from '../../services/billing-stripe-subscription.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

const PortalRequestSchema = BillingSubjectRequestSchema.extend({
  return_url: z.string().trim().url().max(2048),
}).strict();

const tariffSchema = {
  type: 'object',
  additionalProperties: true,
} as const;

const subjectSchema = {
  type: 'object',
  required: ['user_id', 'organisation_id', 'team_id'],
  properties: {
    user_id: { type: 'string' },
    organisation_id: { type: 'string' },
    team_id: { type: 'string' },
  },
} as const;

const subscriptionSchema = {
  type: ['object', 'null'],
  required: [
    'id',
    'status',
    'scope',
    'scope_key',
    'tariff_id',
    'cancel_at_period_end',
    'current_period_start',
    'current_period_end',
    'billing_phase',
    'created_at',
    'synced_at',
  ],
  properties: {
    id: { type: 'string' },
    status: { type: 'string' },
    scope: { type: 'string', enum: ['organisation', 'team'] },
    scope_key: { type: 'string' },
    tariff_id: { type: 'string' },
    cancel_at_period_end: { type: 'boolean' },
    current_period_start: { type: ['string', 'null'] },
    current_period_end: { type: ['string', 'null'] },
    billing_phase: {
      type: 'string',
      enum: ['calendar_month', 'free_alignment_period', 'unknown'],
    },
    created_at: { type: 'string' },
    synced_at: { type: 'string' },
  },
} as const;

const summarySchema = {
  type: 'object',
  required: [
    'product',
    'subject',
    'tariff',
    'assignment',
    'stripe_collection_enabled',
    'stripe_mode',
    'can_manage',
    'subscription',
  ],
  properties: {
    product: { type: 'object', additionalProperties: true },
    subject: subjectSchema,
    tariff: tariffSchema,
    assignment: { type: 'object', additionalProperties: true },
    stripe_collection_enabled: { type: 'boolean' },
    stripe_mode: {
      anyOf: [{ type: 'string', enum: ['test', 'live'] }, { type: 'null' }],
    },
    can_manage: { type: 'boolean' },
    subscription: subscriptionSchema,
  },
} as const;

function requestContext(
  request: FastifyRequest,
  body: z.infer<typeof BillingSubjectRequestSchema>,
): {
  request: BillingSubscriptionRequest;
  actorToken: string;
  credential: NonNullable<FastifyRequest['billingAppKey']>;
} {
  const credential = request.billingAppKey;
  if (!credential) throw new AppError('UNAUTHORIZED', 401);
  return {
    request: {
      product: body.product,
      organisationId: body.organisation_id,
      teamId: body.team_id,
      userId: body.user_id,
    },
    actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
    credential,
  };
}

export function registerStripeSubscriptionRoutes(app: FastifyInstance): void {
  app.post(
    '/billing/v1/stripe/subscription-summary',
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: { response: { 200: summarySchema } },
    },
    async (request, reply) => {
      const body = BillingSubjectRequestSchema.parse(request.body);
      const result = await getStripeSubscriptionSummary(requestContext(request, body));
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(result);
    },
  );

  app.post(
    '/billing/v1/stripe/portal-session',
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: {
        response: {
          201: {
            type: 'object',
            required: ['portal_url'],
            properties: { portal_url: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const body = PortalRequestSchema.parse(request.body);
      const context = requestContext(request, body);
      const result = await createStripePortalSession({
        ...context,
        request: { ...context.request, returnUrl: body.return_url },
      });
      reply.header('Cache-Control', 'private, no-store');
      return reply.status(201).send(result);
    },
  );
}
