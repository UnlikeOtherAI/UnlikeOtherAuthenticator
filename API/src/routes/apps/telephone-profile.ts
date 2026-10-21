import { AppError } from '../../utils/errors.js';
import { reserveTelephoneSms } from '../../services/telephone-sms-reservation.service.js';
import { configuredSmsProvider } from '../../services/billing-sms-runtime.service.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from '../billing/billing-request.js';
import { CALL_PROOF_PATH, telephoneCallProof } from '../../services/telephone-call-proof.service.js';
import { telephoneProfile } from '../../services/telephone-profile.service.js';
import { lookupTelephone } from '../../services/telephone-lookup.service.js';
import { TelephoneNumber, TelephoneVisibility, LOOKUP_PATH, telephoneDenied } from '../../services/telephone-authority.service.js';

const bodies = {
  read: BillingSubjectRequestSchema,
  set: BillingSubjectRequestSchema.extend({ number: TelephoneNumber }).strict(),
  start: BillingSubjectRequestSchema.extend({ number: TelephoneNumber }).strict(),
  verify: BillingSubjectRequestSchema.extend({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }).strict(),
  remove: BillingSubjectRequestSchema,
  visibility: BillingSubjectRequestSchema.extend({ visibility: TelephoneVisibility }).strict(),
};
const limit = createRateLimiter({ limit: 240, windowMs: 60_000,
  keyBuilder: request => `telephone:${request.billingAppKey?.id}` });

export function registerTelephoneProfileRoutes(app: FastifyInstance): void {
  app.post(`${CALL_PROOF_PATH}/reserve`, { bodyLimit: 2048,
    preHandler: [requireBillingLifecycleAppKey, limit] }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (!request.billingAppKey || request.headers['x-uoa-actor'] !== undefined) throw telephoneDenied();
    const id = z.string().min(1).max(160);
    const body = z.object({ number: TelephoneNumber, challengeId: z.string().uuid(), dispatch_id: id,
      request_fingerprint: z.string().regex(/^[a-f0-9]{64}$/), number_id: id, allocation_id: id,
      account_sid: z.string().regex(/^AC[a-fA-F0-9]{32}$/), from: TelephoneNumber,
      max_segments: z.number().int().min(1).max(3) }).strict().parse(request.body);
    try {
      return await reserveTelephoneSms({ credential: request.billingAppKey, request: body,
        serviceToken: readBillingActorHeader(request.headers['x-uoa-service-assertion']) }, { provider: configuredSmsProvider() });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 402 && error.message === 'BILLING_SMS_INSUFFICIENT_CREDITS') {
        return reply.code(402).send({ code: 'BILLING_SMS_INSUFFICIENT_CREDITS',
          reason: 'insufficient_prepaid_credits', can_dispatch: false });
      }
      throw error;
    }
  });
  for (const action of ['start', 'verify'] as const) {
    app.post(`${CALL_PROOF_PATH}/${action}`, { bodyLimit: 1024,
      preHandler: [requireBillingLifecycleAppKey, limit] }, async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!request.billingAppKey || request.headers['x-uoa-actor'] !== undefined) throw telephoneDenied();
      const body = (action === 'start' ? z.object({ number: TelephoneNumber }).strict()
        : z.object({ number: TelephoneNumber, challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }).strict()).parse(request.body);
      return telephoneCallProof({ action, credential: request.billingAppKey, number: body.number,
        challengeId: 'challengeId' in body ? body.challengeId as string : undefined,
        code: 'code' in body ? body.code as string : undefined,
        serviceToken: readBillingActorHeader(request.headers['x-uoa-service-assertion']) });
    });
  }
  for (const action of ['read', 'set', 'start', 'verify', 'remove', 'visibility'] as const) {
    app.post(`/apps/v1/nessie/phone-profile/${action}`, {
      bodyLimit: 4096, preHandler: [requireBillingLifecycleAppKey, limit],
    }, async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!request.billingAppKey || request.headers['x-uoa-service-assertion'] !== undefined) throw telephoneDenied();
      const body = bodies[action].parse(request.body);
      return telephoneProfile({ action, credential: request.billingAppKey,
        actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
        request: { product: body.product, organisationId: body.organisation_id, teamId: body.team_id, userId: body.user_id },
        data: {
          number: 'number' in body ? body.number as string : undefined,
          challengeId: 'challengeId' in body ? body.challengeId as string : undefined,
          code: 'code' in body ? body.code as string : undefined,
          visibility: 'visibility' in body ? TelephoneVisibility.parse(body.visibility) : undefined,
        },
      });
    });
  }
  app.post(LOOKUP_PATH, { bodyLimit: 1024, preHandler: [requireBillingLifecycleAppKey, limit] }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (!request.billingAppKey || request.headers['x-uoa-actor'] !== undefined) throw telephoneDenied();
    const body = z.object({ number: TelephoneNumber }).strict().parse(request.body);
    return lookupTelephone({ credential: request.billingAppKey, number: body.number,
      serviceToken: readBillingActorHeader(request.headers['x-uoa-service-assertion']) });
  });
}
