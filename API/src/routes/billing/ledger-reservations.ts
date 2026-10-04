import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  finalizePrepaidDispatch, getLedgerDispatchDecision, reservePrepaidDispatch,
} from '../../services/billing-prepaid-reservation.service.js';
import { AppError } from '../../utils/errors.js';

const Identifier = z.string().min(1).max(160);
const Decimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/);
const ReserveSchema = z.object({
  dispatch_id: Identifier,
  request_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  dispatch_started_at: z.string().datetime({ offset: true }),
  product: Identifier,
  provider_service_id: Identifier,
  organisation_id: Identifier,
  team_id: Identifier,
  user_id: Identifier,
  raw_cost_bound: Decimal.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();
const ParamsSchema = z.object({ dispatchId: Identifier }).strict();
const SettleSchema = z.object({
  receipt_id: Identifier,
  raw_cost_actual: Decimal,
  currency: z.literal('USD'),
}).strict();
const ReleaseSchema = z.object({
  receipt_id: Identifier,
  proof: z.literal('provider_not_dispatched'),
}).strict();

function runtimeSecret(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    throw new AppError('UNAUTHORIZED', 401, 'LEDGER_RUNTIME_KEY_REQUIRED');
  }
  return authorization.slice('Bearer '.length);
}

function delegation(request: FastifyRequest): string {
  const header = request.headers['x-uoa-delegation'];
  if (typeof header !== 'string' || !header) {
    throw new AppError('UNAUTHORIZED', 401, 'UOA_DELEGATION_REQUIRED');
  }
  return header;
}

export function registerLedgerReservationRoutes(app: FastifyInstance): void {
  app.get('/billing/v1/ledger/reservations/:dispatchId', async (request, reply) => {
    const { dispatchId } = ParamsSchema.parse(request.params);
    const result = await getLedgerDispatchDecision({
      runtimeSecret: runtimeSecret(request), dispatchId,
    });
    reply.header('Cache-Control', 'no-store');
    return result;
  });
  app.post('/billing/v1/ledger/reservations', async (request, reply) => {
    const body = ReserveSchema.parse(request.body);
    const result = await reservePrepaidDispatch({
      runtimeSecret: runtimeSecret(request), delegation: delegation(request),
      input: { dispatchId: body.dispatch_id,
        requestFingerprint: body.request_fingerprint,
        dispatchStartedAt: body.dispatch_started_at,
        product: body.product, providerServiceId: body.provider_service_id,
        organisationId: body.organisation_id, teamId: body.team_id, userId: body.user_id,
        rawCostBound: body.raw_cost_bound, currency: body.currency },
    });
    reply.header('Cache-Control', 'no-store');
    return result;
  });
  app.post('/billing/v1/ledger/reservations/:dispatchId/settle', async (request, reply) => {
    const body = SettleSchema.parse(request.body);
    const { dispatchId } = ParamsSchema.parse(request.params);
    const result = await finalizePrepaidDispatch({ runtimeSecret: runtimeSecret(request),
      dispatchId, receiptId: body.receipt_id, kind: 'settle',
      rawCostActual: body.raw_cost_actual, currency: body.currency });
    reply.header('Cache-Control', 'no-store');
    return result;
  });
  app.post('/billing/v1/ledger/reservations/:dispatchId/release', async (request, reply) => {
    const body = ReleaseSchema.parse(request.body);
    const { dispatchId } = ParamsSchema.parse(request.params);
    const result = await finalizePrepaidDispatch({ runtimeSecret: runtimeSecret(request),
      dispatchId, receiptId: body.receipt_id, kind: 'release' });
    reply.header('Cache-Control', 'no-store');
    return result;
  });
}
