import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { confirmBillingCancellation } from '../../services/billing-cancellation-confirm.service.js';
import { createBillingCancellationPreview } from '../../services/billing-cancellation-preview.service.js';
import type { BillingSubscriptionRequest } from '../../services/billing-stripe-subscription.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

const ConfirmCancellationRequestSchema = BillingSubjectRequestSchema.extend({
  preview_token: z.string().trim().min(32).max(256),
  idempotency_key: z.string().trim().min(16).max(200),
  selection: z
    .enum(['current_service', 'current_and_related_direct_services'])
    .nullable()
    .optional(),
}).strict();

function context(
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
    credential,
    actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
    request: {
      product: body.product,
      organisationId: body.organisation_id,
      teamId: body.team_id,
      userId: body.user_id,
    },
  };
}

export function registerBillingCancellationRoutes(app: FastifyInstance): void {
  app.post(
    '/billing/v1/cancellation/preview',
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: {
        response: { 201: { type: 'object', additionalProperties: true } },
      },
    },
    async (request, reply) => {
      const body = BillingSubjectRequestSchema.parse(request.body);
      const preview = await createBillingCancellationPreview(context(request, body));
      reply.header('Cache-Control', 'private, no-store');
      return reply.status(201).send(preview);
    },
  );

  app.post(
    '/billing/v1/cancellation/confirm',
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: {
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (request, reply) => {
      const body = ConfirmCancellationRequestSchema.parse(request.body);
      const result = await confirmBillingCancellation({
        ...context(request, body),
        token: body.preview_token,
        idempotencyKey: body.idempotency_key,
        selection: body.selection ?? null,
      });
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(result);
    },
  );
}
