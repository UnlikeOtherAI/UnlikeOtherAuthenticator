import type { FastifyInstance } from 'fastify';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as ajvFormats from 'ajv-formats';
import { z } from 'zod';

import {
  BILLING_CONSUMER_ACTION_EXAMPLE_PATH,
  BILLING_CONSUMER_ACTION_OPENAPI_PATH,
  BILLING_CONSUMER_ACTION_SCHEMA_PATH,
  BILLING_STATEMENT_EXAMPLE_PATH,
  BILLING_STATEMENT_OPENAPI_PATH,
  BILLING_STATEMENT_SCHEMA_PATH,
  BILLING_STATEMENT_V2_EXAMPLE_PATH,
  BILLING_STATEMENT_V2_OPENAPI_PATH,
  BILLING_STATEMENT_V2_SCHEMA_PATH,
  billingConsumerActionProtocolV1JsonSchema,
  billingConsumerActionV1ConformanceFixtures,
  billingConsumerActionV1OpenApiDocument,
  billingStatementV1ConformanceFixture,
  billingStatementV1JsonSchema,
  billingStatementV1OpenApiDocument,
  billingStatementV2ConformanceFixture,
  billingStatementV2JsonSchema,
  billingStatementV2OpenApiDocument,
} from '../../contracts/billing-statement-v1.js';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import {
  getCanonicalBillingStatement,
  getCanonicalBillingStatementV2,
} from '../../services/billing-statement.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

const CustomerStatementRequestSchema = BillingSubjectRequestSchema.extend({
  billing_month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
}).strict();

const billingStatementValidator = new Ajv2020({ allErrors: true, strict: true });
ajvFormats.default.default(billingStatementValidator);
const validateBillingStatementV2 = billingStatementValidator.compile(billingStatementV2JsonSchema);

function assertBillingStatementV2Contract(statement: unknown): void {
  if (!validateBillingStatementV2(statement)) {
    throw new AppError('INTERNAL', 500, 'BILLING_STATEMENT_V2_CONTRACT_INVALID');
  }
}

export function registerCustomerStatementRoutes(app: FastifyInstance): void {
  app.get(BILLING_STATEMENT_SCHEMA_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('application/schema+json').send(billingStatementV1JsonSchema);
  });
  app.get(BILLING_STATEMENT_EXAMPLE_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('application/json').send(billingStatementV1ConformanceFixture);
  });
  app.get(BILLING_STATEMENT_OPENAPI_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('application/json').send(billingStatementV1OpenApiDocument);
  });
  app.get(BILLING_STATEMENT_V2_SCHEMA_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('application/schema+json').send(billingStatementV2JsonSchema);
  });
  app.get(BILLING_STATEMENT_V2_EXAMPLE_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('application/json').send(billingStatementV2ConformanceFixture);
  });
  app.get(BILLING_STATEMENT_V2_OPENAPI_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('application/json').send(billingStatementV2OpenApiDocument);
  });
  app.get(BILLING_CONSUMER_ACTION_SCHEMA_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('application/schema+json').send(billingConsumerActionProtocolV1JsonSchema);
  });
  app.get(BILLING_CONSUMER_ACTION_EXAMPLE_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('application/json').send(billingConsumerActionV1ConformanceFixtures);
  });
  app.get(BILLING_CONSUMER_ACTION_OPENAPI_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('application/json').send(billingConsumerActionV1OpenApiDocument);
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
  app.post(
    '/billing/v2/customer-statement',
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: {
        response: {
          200: billingStatementV2JsonSchema,
        },
      },
    },
    async (request, reply) => {
      const body = CustomerStatementRequestSchema.parse(request.body);
      const credential = request.billingAppKey;
      if (!credential) throw new AppError('UNAUTHORIZED', 401);
      const statement = await getCanonicalBillingStatementV2({
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
      assertBillingStatementV2Contract(statement);
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(statement);
    },
  );
}
