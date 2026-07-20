import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  BILLING_STATEMENT_SCHEMA_PATH,
  billingStatementV1JsonSchema,
} from '../../contracts/billing-statement-v1.js';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { getCanonicalBillingStatement } from '../../services/billing-statement.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

const CustomerStatementRequestSchema = BillingSubjectRequestSchema.extend({
  billing_month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
}).strict();

export function registerCustomerStatementRoutes(app: FastifyInstance): void {
  app.get(BILLING_STATEMENT_SCHEMA_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('application/schema+json').send(billingStatementV1JsonSchema);
  });

  app.post(
    '/billing/v1/customer-statement',
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: {
        response: {
          200: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const body = CustomerStatementRequestSchema.parse(request.body);
      const credential = request.billingAppKey;
      if (!credential) throw new AppError('UNAUTHORIZED', 401);
      const statement = await getCanonicalBillingStatement({
        credential,
        actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
        billingMonth: body.billing_month,
        request: {
          product: body.product,
          organisationId: body.organisation_id,
          teamId: body.team_id,
          userId: body.user_id,
        },
      });
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(statement);
    },
  );
}
