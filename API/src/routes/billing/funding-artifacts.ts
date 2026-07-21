import type { FastifyInstance } from 'fastify';

import {
  BILLING_CREDITS_EXAMPLE_PATH,
  BILLING_CREDITS_OPENAPI_PATH,
  BILLING_CREDITS_SCHEMA_PATH,
  BILLING_RECURRING_ADDONS_EXAMPLE_PATH,
  BILLING_RECURRING_ADDONS_OPENAPI_PATH,
  BILLING_RECURRING_ADDONS_SCHEMA_PATH,
  billingCreditsV1ConformanceFixture,
  billingCreditsV1JsonSchema,
  billingCreditsV1OpenApiDocument,
  billingRecurringAddonProtocolV1JsonSchema,
  billingRecurringAddonV1ConformanceFixtures,
  billingRecurringAddonV1OpenApiDocument,
} from '../../contracts/billing-statement-v1.js';

function cachePublic(reply: { header(name: string, value: string): unknown }): void {
  reply.header('Cache-Control', 'public, max-age=300');
}

export function registerBillingFundingArtifactRoutes(app: FastifyInstance): void {
  app.get(BILLING_CREDITS_SCHEMA_PATH, async (_request, reply) => {
    cachePublic(reply);
    return reply.type('application/schema+json').send(billingCreditsV1JsonSchema);
  });
  app.get(BILLING_CREDITS_EXAMPLE_PATH, async (_request, reply) => {
    cachePublic(reply);
    return reply.type('application/json').send(billingCreditsV1ConformanceFixture);
  });
  app.get(BILLING_CREDITS_OPENAPI_PATH, async (_request, reply) => {
    cachePublic(reply);
    return reply.type('application/json').send(billingCreditsV1OpenApiDocument);
  });
  app.get(BILLING_RECURRING_ADDONS_SCHEMA_PATH, async (_request, reply) => {
    cachePublic(reply);
    return reply.type('application/schema+json').send(billingRecurringAddonProtocolV1JsonSchema);
  });
  app.get(BILLING_RECURRING_ADDONS_EXAMPLE_PATH, async (_request, reply) => {
    cachePublic(reply);
    return reply.type('application/json').send(billingRecurringAddonV1ConformanceFixtures);
  });
  app.get(BILLING_RECURRING_ADDONS_OPENAPI_PATH, async (_request, reply) => {
    cachePublic(reply);
    return reply.type('application/json').send(billingRecurringAddonV1OpenApiDocument);
  });
}
