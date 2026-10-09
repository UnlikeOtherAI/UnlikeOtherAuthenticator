import type { FastifyInstance } from 'fastify';
import { BILLING_SMS_PATHS, billingSmsReserveRequestV1JsonSchema, billingSmsReservationReadRequestV1JsonSchema,
  billingSmsClaimRequestV1JsonSchema, billingSmsReceiptRequestV1JsonSchema, billingSmsReleaseRequestV1JsonSchema,
  billingSmsReservationV1JsonSchema, billingSmsReleaseResultV1JsonSchema, billingSmsInsufficientCreditsV1JsonSchema,
  type BillingSmsReserveRequestV1, type BillingSmsReservationReadRequestV1, type BillingSmsClaimRequestV1,
  type BillingSmsReceiptRequestV1, type BillingSmsReleaseRequestV1 } from '@unlikeotherai/billing-statement-protocol';
import { requireBillingAppKey, requireBillingSmsRuntimeAppKey } from '../../middleware/billing-app-auth.js';
import { reserveSms } from '../../services/billing-sms-reservation.service.js';
import { readSmsReservation, claimSmsDispatch, releaseSmsDispatch } from '../../services/billing-sms-dispatch.service.js';
import { settleSmsReceipt } from '../../services/billing-sms-receipt.service.js';
import { configuredSmsProvider } from '../../services/billing-sms-runtime.service.js';
import { AppError } from '../../utils/errors.js';
import { readBillingActorHeader } from './billing-request.js';

export function registerSmsReservationRoutes(app: FastifyInstance): void {
  app.post<{ Body: BillingSmsReserveRequestV1 }>(BILLING_SMS_PATHS.reserve, {
    preHandler: [requireBillingAppKey], schema: { body: billingSmsReserveRequestV1JsonSchema,
      response: { 200: billingSmsReservationV1JsonSchema, 402: billingSmsInsufficientCreditsV1JsonSchema } },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    try {
      return await reserveSms({ request: request.body, credential: request.billingAppKey,
        actorToken: request.body.grant_id === null ? readBillingActorHeader(request.headers['x-uoa-actor']) : undefined },
      { provider: configuredSmsProvider() });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 402 && error.message === 'BILLING_SMS_INSUFFICIENT_CREDITS') {
        return reply.code(402).send({ code: 'BILLING_SMS_INSUFFICIENT_CREDITS',
          reason: 'insufficient_prepaid_credits', can_dispatch: false });
      }
      throw error;
    }
  });
  app.post<{ Body: BillingSmsReservationReadRequestV1 }>(BILLING_SMS_PATHS.reservation, {
    preHandler: [requireBillingSmsRuntimeAppKey], schema: {
      body: billingSmsReservationReadRequestV1JsonSchema, response: { 200: billingSmsReservationV1JsonSchema },
    },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return readSmsReservation({ request: request.body, credential: request.billingAppKey });
  });
  app.post<{ Body: BillingSmsClaimRequestV1 }>(BILLING_SMS_PATHS.claim, {
    preHandler: [requireBillingSmsRuntimeAppKey], schema: {
      body: billingSmsClaimRequestV1JsonSchema, response: { 200: billingSmsReservationV1JsonSchema },
    },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return claimSmsDispatch({ request: request.body, credential: request.billingAppKey }, { provider: configuredSmsProvider() });
  });
  app.post<{ Body: BillingSmsReceiptRequestV1 }>(BILLING_SMS_PATHS.receipt, {
    preHandler: [requireBillingSmsRuntimeAppKey], schema: {
      body: billingSmsReceiptRequestV1JsonSchema, response: { 200: billingSmsReservationV1JsonSchema },
    },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return settleSmsReceipt({ request: request.body, credential: request.billingAppKey }, { provider: configuredSmsProvider() });
  });
  app.post<{ Body: BillingSmsReleaseRequestV1 }>(BILLING_SMS_PATHS.release, {
    preHandler: [requireBillingSmsRuntimeAppKey], schema: {
      body: billingSmsReleaseRequestV1JsonSchema, response: { 200: billingSmsReleaseResultV1JsonSchema },
    },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return releaseSmsDispatch({ request: request.body, credential: request.billingAppKey });
  });
}
