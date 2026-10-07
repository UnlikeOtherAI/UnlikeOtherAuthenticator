import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as ajvFormats from 'ajv-formats';
import { z } from 'zod';

import {
  BILLING_CUSTOMER_INVOICES_DETAIL_PATH,
  BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH,
  BILLING_CUSTOMER_INVOICES_EXAMPLE_PATH,
  BILLING_CUSTOMER_INVOICES_LIST_PATH,
  BILLING_CUSTOMER_INVOICES_OPENAPI_PATH,
  BILLING_CUSTOMER_INVOICES_SCHEMA_PATH,
  billingCustomerInvoiceDetailV1JsonSchema,
  billingCustomerInvoiceDetailV1ConformanceFixture,
  billingCustomerInvoiceDownloadRequestV1ConformanceFixture,
  billingCustomerInvoicePendingDetailV1ConformanceFixture,
  billingCustomerInvoicesListV1JsonSchema,
  billingCustomerInvoicesListV1ConformanceFixture,
  billingCustomerInvoicesProtocolV1JsonSchema,
  billingCustomerInvoicesV1OpenApiDocument,
} from '../../contracts/billing-statement-v1.js';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import type { BillingCycleContext } from '../../services/billing-cycle-read.service.js';
import {
  downloadCustomerInvoice, getCustomerInvoiceDetail, listCustomerInvoices,
} from '../../services/billing-customer-invoice-read.service.js';
import { AppError } from '../../utils/errors.js';
import { readBillingPresentation } from './billing-presentation.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

const validator = new Ajv2020({ allErrors: true, strict: true });
ajvFormats.default.default(validator);
const validateList = validator.compile(billingCustomerInvoicesListV1JsonSchema);
const validateDetail = validator.compile(billingCustomerInvoiceDetailV1JsonSchema);
const listRequest = BillingSubjectRequestSchema.extend({
  charge_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(256).optional(),
}).strict();
const detailRequest = BillingSubjectRequestSchema.extend({
  invoice_id: z.string().min(1).max(256),
  charge_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
}).strict();
const downloadRequest = BillingSubjectRequestSchema.extend({
  invoice_id: z.string().min(1).max(256),
  document_id: z.string().min(1).max(256),
}).strict();

function context(request: FastifyRequest,
  body: z.infer<typeof BillingSubjectRequestSchema>,
  endpoint: BillingCycleContext['endpoint']): BillingCycleContext {
  if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
  const presentation = readBillingPresentation(request.headers);
  return { credential: request.billingAppKey,
    locale: presentation.enabled ? presentation.locale : undefined,
    actorToken: readBillingActorHeader(request.headers['x-uoa-actor']), endpoint,
    request: { product: body.product, organisationId: body.organisation_id,
      teamId: body.team_id, userId: body.user_id } };
}

function contract(value: unknown, validate: (value: unknown) => boolean): void {
  if (!validate(value)) throw new AppError('INTERNAL', 503, 'BILLING_CUSTOMER_INVOICE_CONTRACT_INVALID');
}

export function registerBillingCustomerInvoiceRoutes(app: FastifyInstance): void {
  app.get(BILLING_CUSTOMER_INVOICES_SCHEMA_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('application/schema+json').send(billingCustomerInvoicesProtocolV1JsonSchema);
  });
  app.get(BILLING_CUSTOMER_INVOICES_EXAMPLE_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('application/json').send({ list: billingCustomerInvoicesListV1ConformanceFixture,
      detail: billingCustomerInvoiceDetailV1ConformanceFixture,
      pending_detail: billingCustomerInvoicePendingDetailV1ConformanceFixture,
      download_request: billingCustomerInvoiceDownloadRequestV1ConformanceFixture });
  });
  app.get(BILLING_CUSTOMER_INVOICES_OPENAPI_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('application/json').send(billingCustomerInvoicesV1OpenApiDocument);
  });
  app.post(BILLING_CUSTOMER_INVOICES_LIST_PATH,
    { preHandler: [requireBillingLifecycleAppKey] }, async (request, reply) => {
      const body = listRequest.parse(request.body);
      const value = await listCustomerInvoices(context(request, body,
        BILLING_CUSTOMER_INVOICES_LIST_PATH), {
        chargeMonth: body.charge_month, limit: body.limit, cursor: body.cursor,
      });
      contract(value, validateList);
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(value);
    });
  app.post(BILLING_CUSTOMER_INVOICES_DETAIL_PATH,
    { preHandler: [requireBillingLifecycleAppKey] }, async (request, reply) => {
      const body = detailRequest.parse(request.body);
      const value = await getCustomerInvoiceDetail(context(request, body,
        BILLING_CUSTOMER_INVOICES_DETAIL_PATH), body.invoice_id,
      { chargeMonth: body.charge_month });
      contract(value, validateDetail);
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(value);
    });
  app.post(BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH,
    { preHandler: [requireBillingLifecycleAppKey] }, async (request, reply) => {
      const body = downloadRequest.parse(request.body);
      const document = await downloadCustomerInvoice(context(request, body,
        BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH), body.invoice_id, body.document_id);
      reply.header('Cache-Control', 'private, no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Disposition', `attachment; filename="${document.filename}"`);
      return reply.type(document.contentType).send(document.bytes);
    });
}
