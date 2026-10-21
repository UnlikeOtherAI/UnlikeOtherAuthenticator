import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from '../billing/billing-request.js';
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
        data: body,
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
