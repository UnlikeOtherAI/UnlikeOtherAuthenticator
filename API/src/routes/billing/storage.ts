import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { storageReadV1JsonSchema } from '@unlikeotherai/billing-statement-protocol';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { readStorageSetup, createStorageMandate } from '../../services/billing-storage-mandate.service.js';
import { recoverStorage } from '../../services/billing-storage-recovery.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

const mandate = BillingSubjectRequestSchema.extend({ catalog_id: z.string().min(1).max(256),
  consent_version: z.literal('company-storage-auto-expansion-v1'), accepted: z.literal(true) }).strict();
export function registerStorageRoutes(app: FastifyInstance) {
  const preHandler = [requireBillingLifecycleAppKey];
  app.post('/billing/v1/storage', { preHandler, schema: { response: { 200: storageReadV1JsonSchema } } }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return readStorageSetup({ request: BillingSubjectRequestSchema.parse(request.body),
      credential: request.billingAppKey, actorToken: readBillingActorHeader(request.headers['x-uoa-actor']) });
  });
  app.post('/billing/v1/storage/mandate', { preHandler }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return createStorageMandate({ request: mandate.parse(request.body), credential: request.billingAppKey,
      actorToken: readBillingActorHeader(request.headers['x-uoa-actor']) });
  });
  app.post('/billing/v1/storage/recover', { preHandler }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    const body = BillingSubjectRequestSchema.extend({ expansion_id: z.string().min(1).max(256),
      mandate_id: z.string().min(1).max(256).optional() }).strict().parse(request.body);
    return recoverStorage({ request: body, credential: request.billingAppKey,
      actorToken: readBillingActorHeader(request.headers['x-uoa-actor']) });
  });
}
