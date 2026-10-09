import type { FastifyInstance } from 'fastify';
import { BILLING_SMS_PATHS, billingSmsStandingHoldRequestV1JsonSchema,
  billingSmsStandingReadRequestV1JsonSchema, billingSmsStandingHoldV1JsonSchema,
  billingSmsStandingRetireResultV1JsonSchema,
  billingSmsInboundReceiptRequestV1JsonSchema, billingSmsInboundReceiptV1JsonSchema,
  billingSmsInsufficientCreditsV1JsonSchema, type BillingSmsStandingHoldRequestV1,
  type BillingSmsStandingReadRequestV1, type BillingSmsInboundReceiptRequestV1 } from
  '@unlikeotherai/billing-statement-protocol';
import { requireBillingLifecycleAppKey, requireBillingSmsRuntimeAppKey } from
  '../../middleware/billing-app-auth.js';
import { fundSmsStanding, readSmsStanding } from '../../services/billing-sms-standing.service.js';
import { settleSmsInbound } from '../../services/billing-sms-inbound.service.js';
import { configuredSmsProvider } from '../../services/billing-sms-runtime.service.js';
import { AppError } from '../../utils/errors.js';
import { readBillingActorHeader } from './billing-request.js';

export function registerSmsInboundRoutes(app: FastifyInstance): void {
  app.post<{ Body: BillingSmsStandingHoldRequestV1 }>(BILLING_SMS_PATHS.standingHold, {
    preHandler: [requireBillingLifecycleAppKey], schema: {
      body: billingSmsStandingHoldRequestV1JsonSchema,
      response: { 200: billingSmsStandingHoldV1JsonSchema, 402: billingSmsInsufficientCreditsV1JsonSchema },
    },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    try {
      return await fundSmsStanding({ request: request.body, credential: request.billingAppKey,
        actorToken: readBillingActorHeader(request.headers['x-uoa-actor']) }, { provider: configuredSmsProvider() });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 402 && error.message === 'BILLING_SMS_INSUFFICIENT_CREDITS') {
        return reply.code(402).send({ code: 'BILLING_SMS_INSUFFICIENT_CREDITS',
          reason: 'insufficient_prepaid_credits', can_dispatch: false });
      }
      throw error;
    }
  });
  for (const [path, retire] of [[BILLING_SMS_PATHS.standingStatus, false], [BILLING_SMS_PATHS.standingRetire, true]] as const) {
    app.post<{ Body: BillingSmsStandingReadRequestV1 }>(path, {
      preHandler: [requireBillingSmsRuntimeAppKey], schema: {
        body: billingSmsStandingReadRequestV1JsonSchema,
        response: { 200: retire ? billingSmsStandingRetireResultV1JsonSchema : billingSmsStandingHoldV1JsonSchema },
      },
    }, async (request, reply) => {
      if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
      reply.header('Cache-Control', 'private, no-store');
      return readSmsStanding({ request: request.body, credential: request.billingAppKey, retire });
    });
  }
  app.post<{ Body: BillingSmsInboundReceiptRequestV1 }>(BILLING_SMS_PATHS.inboundReceipt, {
    preHandler: [requireBillingSmsRuntimeAppKey], schema: {
      body: billingSmsInboundReceiptRequestV1JsonSchema, response: { 200: billingSmsInboundReceiptV1JsonSchema },
    },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return settleSmsInbound({ request: request.body, credential: request.billingAppKey }, { provider: configuredSmsProvider() });
  });
}
