import type { FastifyInstance } from 'fastify';

import { handleStripeWebhook } from '../../services/billing-stripe-webhook.service.js';
import { AppError } from '../../utils/errors.js';

function readStripeSignature(value: string | string[] | undefined): string {
  if (value === undefined || Array.isArray(value) || !value.trim()) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_STRIPE_WEBHOOK_SIGNATURE');
  }
  return value.trim();
}

export function registerStripeWebhookRoute(app: FastifyInstance): void {
  app.post(
    '/billing/v1/stripe/webhook',
    {
      config: { rawBody: true },
      bodyLimit: 256 * 1024,
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['received'],
            properties: { received: { type: 'boolean' } },
          },
        },
      },
    },
    async (request) => {
      if (!Buffer.isBuffer(request.rawBody)) {
        throw new AppError('BAD_REQUEST', 400, 'INVALID_STRIPE_WEBHOOK_BODY');
      }
      await handleStripeWebhook({
        rawBody: request.rawBody,
        signature: readStripeSignature(request.headers['stripe-signature']),
      });
      return { received: true };
    },
  );
}
