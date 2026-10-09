import type { FastifyInstance } from 'fastify';
import { BILLING_SMS_PATHS, billingSmsGrantRequestV1JsonSchema, billingSmsGrantReadRequestV1JsonSchema,
  billingSmsGrantQuoteRequestV1JsonSchema, billingSmsGrantV1JsonSchema, billingSmsGrantRevokeResultV1JsonSchema,
  billingSmsFinalQuoteV1JsonSchema, type BillingSmsGrantRequestV1, type BillingSmsGrantReadRequestV1,
  type BillingSmsGrantQuoteRequestV1 } from '@unlikeotherai/billing-statement-protocol';
import { requireBillingLifecycleAppKey, requireBillingSmsRuntimeAppKey } from '../../middleware/billing-app-auth.js';
import { createSmsGrant, readSmsGrant, revokeSmsGrant, grantSubject,
  lockSmsGrant } from '../../services/billing-sms-grant.service.js';
import { configuredSmsProvider } from '../../services/billing-sms-runtime.service.js';
import { issueSmsQuote } from '../../services/billing-sms-quote.service.js';
import { getAdminPrisma } from '../../db/prisma.js';
import { AppError } from '../../utils/errors.js';
import { readBillingActorHeader } from './billing-request.js';

export function registerSmsGrantRoutes(app: FastifyInstance): void {
  app.post<{ Body: BillingSmsGrantRequestV1 }>(BILLING_SMS_PATHS.grant, {
    preHandler: [requireBillingLifecycleAppKey], schema: {
      body: billingSmsGrantRequestV1JsonSchema, response: { 200: billingSmsGrantV1JsonSchema },
    },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return createSmsGrant({ request: request.body, credential: request.billingAppKey,
      actorToken: readBillingActorHeader(request.headers['x-uoa-actor']) });
  });
  app.post<{ Body: BillingSmsGrantReadRequestV1 }>(BILLING_SMS_PATHS.grantRead, {
    preHandler: [requireBillingSmsRuntimeAppKey], schema: {
      body: billingSmsGrantReadRequestV1JsonSchema, response: { 200: billingSmsGrantV1JsonSchema },
    },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return readSmsGrant({ request: request.body, credential: request.billingAppKey });
  });
  app.post<{ Body: BillingSmsGrantReadRequestV1 }>(BILLING_SMS_PATHS.grantRevoke, {
    preHandler: [requireBillingSmsRuntimeAppKey], schema: {
      body: billingSmsGrantReadRequestV1JsonSchema, response: { 200: billingSmsGrantRevokeResultV1JsonSchema },
    },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return revokeSmsGrant({ request: request.body, credential: request.billingAppKey });
  });
  app.post<{ Body: BillingSmsGrantQuoteRequestV1 }>(BILLING_SMS_PATHS.grantQuote, {
    preHandler: [requireBillingSmsRuntimeAppKey], schema: {
      body: billingSmsGrantQuoteRequestV1JsonSchema, response: { 200: billingSmsFinalQuoteV1JsonSchema },
    },
  }, async (request, reply) => {
    const credential = request.billingAppKey;
    if (!credential) throw new AppError('UNAUTHORIZED', 401);
    const prisma = getAdminPrisma();
    const grant = await prisma.billingSmsDispatchGrant.findUnique({ where: { id: request.body.grant_id } });
    if (!grant || grant.serviceId !== credential.service.id) throw new AppError('NOT_FOUND', 404);
    const result = await issueSmsQuote({ credential, request: {
      ...grantSubject(grant, request.body.product), country: request.body.country,
      number_type: 'mobile', direction: 'outbound', destination: request.body.destination,
      carrier: null, mcc: null, mnc: null,
    }, authorize: (tx) => lockSmsGrant(tx, { credential, grantId: grant.id, product: request.body.product }) },
    { provider: configuredSmsProvider(), prisma });
    reply.header('Cache-Control', 'private, no-store');
    return result;
  });
}
