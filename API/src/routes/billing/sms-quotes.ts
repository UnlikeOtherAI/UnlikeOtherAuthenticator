import type { FastifyInstance } from 'fastify';
import {
  BILLING_SMS_PATHS, billingSmsQuoteRequestV1JsonSchema, billingSmsVerifyQuoteRequestV1JsonSchema,
  billingSmsFinalQuoteV1JsonSchema, type BillingSmsQuoteRequestV1, type BillingSmsVerifyQuoteRequestV1,
} from '@unlikeotherai/billing-statement-protocol';
import { requireBillingEntitlementAppKey } from '../../middleware/billing-app-auth.js';
import { createSmsQuote, verifySmsQuote } from '../../services/billing-sms-quote.service.js';
import { configuredSmsProvider } from '../../services/billing-sms-runtime.service.js';
import type { BillingSmsProvider } from '../../services/billing-sms-provider.service.js';
import { AppError } from '../../utils/errors.js';
import { readBillingActorHeader } from './billing-request.js';

export function registerSmsQuoteRoutes(app: FastifyInstance, deps?: { provider?: BillingSmsProvider }): void {
  app.post<{ Body: BillingSmsQuoteRequestV1 }>(BILLING_SMS_PATHS.quote, {
    preHandler: [requireBillingEntitlementAppKey], schema: {
      body: billingSmsQuoteRequestV1JsonSchema, response: { 200: billingSmsFinalQuoteV1JsonSchema },
    },
  }, async (request, reply) => {
    const credential = request.billingAppKey;
    if (!credential) throw new AppError('UNAUTHORIZED', 401);
    const result = await createSmsQuote({ request: request.body, credential,
      actorToken: readBillingActorHeader(request.headers['x-uoa-actor']) },
    { provider: deps?.provider ?? configuredSmsProvider() });
    reply.header('Cache-Control', 'private, no-store');
    return result;
  });
  app.post<{ Body: BillingSmsVerifyQuoteRequestV1 }>(BILLING_SMS_PATHS.verifyQuote, {
    preHandler: [requireBillingEntitlementAppKey], schema: {
      body: billingSmsVerifyQuoteRequestV1JsonSchema, response: { 200: billingSmsFinalQuoteV1JsonSchema },
    },
  }, async (request, reply) => {
    const credential = request.billingAppKey;
    if (!credential) throw new AppError('UNAUTHORIZED', 401);
    const result = await verifySmsQuote({ request: request.body, credential,
      actorToken: readBillingActorHeader(request.headers['x-uoa-actor']) });
    reply.header('Cache-Control', 'private, no-store');
    return result;
  });
}
