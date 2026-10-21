import type { FastifyInstance } from 'fastify';
import {
  BILLING_VOICE_PATHS as paths, billingVoiceGrantRequestV1JsonSchema, billingVoiceGrantReadRequestV1JsonSchema,
  billingVoiceQuoteRequestV1JsonSchema, billingVoiceReserveRequestV1JsonSchema, billingVoiceReadRequestV1JsonSchema,
  billingVoiceClaimRequestV1JsonSchema, billingVoiceReceiptRequestV1JsonSchema, billingVoiceReleaseRequestV1JsonSchema,
  billingVoiceGrantV1JsonSchema, billingVoiceQuoteV1JsonSchema, billingVoiceReservationV1JsonSchema,
  type BillingVoiceGrantRequestV1, type BillingVoiceGrantReadRequestV1, type BillingVoiceQuoteRequestV1,
  type BillingVoiceReserveRequestV1, type BillingVoiceReadRequestV1, type BillingVoiceClaimRequestV1,
  type BillingVoiceReceiptRequestV1, type BillingVoiceReleaseRequestV1,
} from '@unlikeotherai/billing-statement-protocol';
import { requireBillingLifecycleAppKey, requireBillingVoiceRuntimeAppKey } from '../../middleware/billing-app-auth.js';
import { createVoiceGrant, readVoiceGrant, revokeVoiceGrant } from '../../services/billing-voice-grant.service.js';
import { issueVoiceQuote, configuredVoiceDependencies } from '../../services/billing-voice-quote.service.js';
import { reserveVoice } from '../../services/billing-voice-reservation.service.js';
import { readVoiceReservation, claimVoice, releaseVoice } from '../../services/billing-voice-dispatch.service.js';
import { settleVoice } from '../../services/billing-voice-receipt.service.js';
import { BillingVoiceProvider } from '../../services/billing-voice-provider.service.js';
import { configuredSmsProvider } from '../../services/billing-sms-runtime.service.js';
import { AppError } from '../../utils/errors.js';
import { readBillingActorHeader } from './billing-request.js';

export function registerVoiceRoutes(app: FastifyInstance): void {
  app.post<{ Body: BillingVoiceGrantRequestV1 }>(paths.grant, { preHandler: [requireBillingLifecycleAppKey],
    schema: { body: billingVoiceGrantRequestV1JsonSchema, response: { 200: billingVoiceGrantV1JsonSchema } },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return createVoiceGrant({ request: request.body, credential: request.billingAppKey,
      actorToken: readBillingActorHeader(request.headers['x-uoa-actor']) });
  });
  for (const [path, action] of [[paths.grantRead, readVoiceGrant], [paths.grantRevoke, revokeVoiceGrant]] as const) {
    app.post<{ Body: BillingVoiceGrantReadRequestV1 }>(path, { preHandler: [requireBillingVoiceRuntimeAppKey],
      schema: { body: billingVoiceGrantReadRequestV1JsonSchema, response: { 200: billingVoiceGrantV1JsonSchema } },
    }, async (request, reply) => {
      if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
      reply.header('Cache-Control', 'private, no-store');
      return action({ request: request.body, credential: request.billingAppKey });
    });
  }
  app.post<{ Body: BillingVoiceQuoteRequestV1 }>(paths.quote, { preHandler: [requireBillingVoiceRuntimeAppKey],
    schema: { body: billingVoiceQuoteRequestV1JsonSchema, response: { 200: billingVoiceQuoteV1JsonSchema } },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return issueVoiceQuote({ request: request.body, credential: request.billingAppKey }, configuredVoiceDependencies());
  });
  app.post<{ Body: BillingVoiceReserveRequestV1 }>(paths.reserve, { preHandler: [requireBillingVoiceRuntimeAppKey],
    schema: { body: billingVoiceReserveRequestV1JsonSchema, response: { 200: billingVoiceReservationV1JsonSchema } },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    try { return await reserveVoice({ request: request.body, credential: request.billingAppKey }, configuredVoiceDependencies()); }
    catch (error) {
      if (error instanceof AppError && error.statusCode === 402) return reply.code(402).send({
        code: 'BILLING_VOICE_INSUFFICIENT_CREDITS', reason: 'insufficient_prepaid_credits', can_dispatch: false,
      });
      throw error;
    }
  });
  app.post<{ Body: BillingVoiceReadRequestV1 }>(paths.read, { preHandler: [requireBillingVoiceRuntimeAppKey],
    schema: { body: billingVoiceReadRequestV1JsonSchema, response: { 200: billingVoiceReservationV1JsonSchema } },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return readVoiceReservation({ request: request.body, credential: request.billingAppKey });
  });
  app.post<{ Body: BillingVoiceClaimRequestV1 }>(paths.claim, { preHandler: [requireBillingVoiceRuntimeAppKey],
    schema: { body: billingVoiceClaimRequestV1JsonSchema, response: { 200: billingVoiceReservationV1JsonSchema } },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return claimVoice({ request: request.body, credential: request.billingAppKey }, configuredVoiceDependencies());
  });
  app.post<{ Body: BillingVoiceReceiptRequestV1 }>(paths.receipt, { preHandler: [requireBillingVoiceRuntimeAppKey],
    schema: { body: billingVoiceReceiptRequestV1JsonSchema, response: { 200: billingVoiceReservationV1JsonSchema } },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return settleVoice({ request: request.body, credential: request.billingAppKey }, {
      voice: new BillingVoiceProvider(configuredSmsProvider().configuration),
    });
  });
  app.post<{ Body: BillingVoiceReleaseRequestV1 }>(paths.release, { preHandler: [requireBillingVoiceRuntimeAppKey],
    schema: { body: billingVoiceReleaseRequestV1JsonSchema, response: { 200: billingVoiceReservationV1JsonSchema } },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return releaseVoice({ request: request.body, credential: request.billingAppKey });
  });
}
