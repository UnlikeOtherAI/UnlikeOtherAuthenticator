import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { commercialEventsV1JsonSchema, storageEnsureV1JsonSchema, phoneReleaseVerdictV1JsonSchema,
  commercialProtocolV1JsonSchema } from '@unlikeotherai/billing-statement-protocol';
import { requireBillingCommercialWorkerKey } from '../../middleware/billing-app-auth.js';
import { ensureStorageCapacity, recordStorageObservation } from '../../services/billing-storage-expansion.service.js';
import { acknowledgeCommercialEvent, listCommercialEvents } from '../../services/billing-commercial-events.service.js';
import { phoneReleaseVerdict } from '../../services/billing-phone-release.service.js';
import { AppError } from '../../utils/errors.js';
import { CommercialScopeSchema } from './product-entitlement.js';

const id = z.string().min(1).max(256);
const bytes = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const ensure = CommercialScopeSchema.extend({ operation_id: id, minimum_capacity_bytes: bytes }).strict();
const observation = CommercialScopeSchema.extend({ observation_id: id, revision: bytes,
  observed_at: z.string().datetime(), measurement_version: id, blob_bytes: bytes, database_bytes: bytes }).strict();
const ack = CommercialScopeSchema.extend({ event_id: id, recipient_user_id: id,
  channel: z.enum(['alert', 'personal_assistant']), receipt_id: id }).strict();
const release = CommercialScopeSchema.extend({ incident_id: id }).strict();

export function registerCommercialWorkerRoutes(app: FastifyInstance) {
  const preHandler = [requireBillingCommercialWorkerKey];
  app.post('/billing/v1/storage/ensure-capacity', { preHandler, schema: { response: { 200: storageEnsureV1JsonSchema } } },
    async (request, reply) => {
      if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
      reply.header('Cache-Control', 'private, no-store');
      return ensureStorageCapacity({ request: ensure.parse(request.body), credential: request.billingAppKey });
    });
  app.post('/billing/v1/storage/observations', { preHandler }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return recordStorageObservation({ request: observation.parse(request.body), credential: request.billingAppKey });
  });
  app.post('/billing/v1/commercial-events', { preHandler, schema: { response: { 200: commercialEventsV1JsonSchema } } },
    async (request, reply) => {
      if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
      reply.header('Cache-Control', 'private, no-store');
      return listCommercialEvents({ request: CommercialScopeSchema.parse(request.body), credential: request.billingAppKey });
    });
  app.post('/billing/v1/commercial-events/acknowledge', { preHandler }, async (request) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    return acknowledgeCommercialEvent({ request: ack.parse(request.body), credential: request.billingAppKey });
  });
  app.post('/billing/v1/commercial-events/phone-release', { preHandler,
    schema: { response: { 200: phoneReleaseVerdictV1JsonSchema } } }, async (request, reply) => {
      if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
      reply.header('Cache-Control', 'private, no-store');
      return phoneReleaseVerdict({ request: release.parse(request.body), credential: request.billingAppKey });
    });
  app.get('/schemas/commercial-policy-v1.json', async () => commercialProtocolV1JsonSchema);
}
