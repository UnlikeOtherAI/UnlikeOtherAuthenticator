import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as ajvFormats from 'ajv-formats';
import { z } from 'zod';

import {
  BILLING_CYCLES_DETAIL_PATH,
  BILLING_CYCLES_DOWNLOAD_PATH,
  BILLING_CYCLES_EXAMPLE_PATH,
  BILLING_CYCLES_LIST_PATH,
  BILLING_CYCLES_OPENAPI_PATH,
  BILLING_CYCLES_SCHEMA_PATH,
  billingCycleDetailV2ConformanceFixture,
  billingCycleDetailV2JsonSchema,
  billingCycleDownloadRequestV2ConformanceFixture,
  billingCyclesListV2ConformanceFixture,
  billingCyclesListV2JsonSchema,
  billingCyclesProtocolV2JsonSchema,
  billingCyclesV2OpenApiDocument,
} from '../../contracts/billing-statement-v1.js';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import {
  downloadBillingCycleDocument,
  getBillingCycleDetail,
  listBillingCycles,
} from '../../services/billing-cycle-read.service.js';
import { AppError } from '../../utils/errors.js';
import { readBillingPresentation } from './billing-presentation.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

const validator = new Ajv2020({ allErrors: true, strict: true });
ajvFormats.default.default(validator);
const validateList = validator.compile(billingCyclesListV2JsonSchema);
const validateDetail = validator.compile(billingCycleDetailV2JsonSchema);
const listRequest = BillingSubjectRequestSchema.extend({
  limit: z.number().int().min(1).max(24).optional(),
  cursor: z.string().regex(/^\d{4}-(0[1-9]|1[0-2]):(team|organisation)$/).optional(),
}).strict();
const detailRequest = BillingSubjectRequestSchema.extend({
  cycle_id: z.string().min(1).max(256),
}).strict();
const downloadRequest = detailRequest.extend({
  document_id: z.string().min(1).max(256),
}).strict();

function context(
  request: FastifyRequest,
  body: z.infer<typeof BillingSubjectRequestSchema>,
  endpoint: Parameters<typeof listBillingCycles>[0]['endpoint'],
) {
  if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
  const presentation = readBillingPresentation(request.headers);
  return {
    credential: request.billingAppKey,
    locale: presentation.enabled ? presentation.locale : undefined,
    actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
    endpoint,
    request: {
      product: body.product,
      organisationId: body.organisation_id,
      teamId: body.team_id,
      userId: body.user_id,
    },
  };
}

function assertContract(validate: (value: unknown) => boolean, value: unknown): void {
  if (!validate(value)) throw new AppError('INTERNAL', 503, 'BILLING_CYCLE_CONTRACT_INVALID');
}

export function registerBillingCycleRoutes(app: FastifyInstance): void {
  app.get(BILLING_CYCLES_SCHEMA_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('application/schema+json').send(billingCyclesProtocolV2JsonSchema);
  });
  app.get(BILLING_CYCLES_EXAMPLE_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('application/json').send({ list: billingCyclesListV2ConformanceFixture,
      detail: billingCycleDetailV2ConformanceFixture,
      download_request: billingCycleDownloadRequestV2ConformanceFixture });
  });
  app.get(BILLING_CYCLES_OPENAPI_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('application/json').send(billingCyclesV2OpenApiDocument);
  });
  app.post(BILLING_CYCLES_LIST_PATH, { preHandler: [requireBillingLifecycleAppKey] },
    async (request, reply) => {
      const body = listRequest.parse(request.body);
      const value = await listBillingCycles(context(request, body, BILLING_CYCLES_LIST_PATH),
        { limit: body.limit, cursor: body.cursor });
      assertContract(validateList, value);
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(value);
    });
  app.post(BILLING_CYCLES_DETAIL_PATH, { preHandler: [requireBillingLifecycleAppKey] },
    async (request, reply) => {
      const body = detailRequest.parse(request.body);
      const value = await getBillingCycleDetail(context(request, body, BILLING_CYCLES_DETAIL_PATH),
        body.cycle_id);
      assertContract(validateDetail, value);
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(value);
    });
  app.post(BILLING_CYCLES_DOWNLOAD_PATH, { preHandler: [requireBillingLifecycleAppKey] },
    async (request, reply) => {
      const body = downloadRequest.parse(request.body);
      const document = await downloadBillingCycleDocument(
        context(request, body, BILLING_CYCLES_DOWNLOAD_PATH), body.cycle_id, body.document_id,
      );
      reply.header('Cache-Control', 'private, no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Disposition', `attachment; filename="${document.filename}"`);
      return reply.type(document.contentType).send(document.bytes);
    });
}
