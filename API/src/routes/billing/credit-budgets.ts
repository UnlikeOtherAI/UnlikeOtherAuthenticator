import type { FastifyInstance, FastifyRequest } from 'fastify';
import { decodeJwt } from 'jose';
import { z } from 'zod';

import { BILLING_CREDIT_BUDGET_LIST_PATH } from '../../contracts/billing-statement-v1.js';
import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { deleteCreditBudget, listCreditBudgets, putCreditBudget,
  registerNativeBudgetScope } from
  '../../services/billing-credit-budget-management.service.js';
import { AppError } from '../../utils/errors.js';
import { readBillingActorHeader } from './billing-request.js';

const Identifier = z.string().trim().min(1).max(256);
const Subject = z.object({ product: Identifier,
  organization_id: Identifier, team_id: Identifier }).strict();
const Policy = Subject.extend({
  scope_type: z.enum(['organization', 'team', 'project', 'run']),
  scope_id: Identifier,
  period: z.enum(['weekly', 'monthly', 'yearly', 'per_run']),
  mode: z.enum(['off', 'warn', 'enforce', 'degrade', 'unlimited']),
  limit_credits: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/).nullable(),
  warn_threshold_percent: z.number().int().min(0).max(100),
  block_humans_when_over: z.boolean(),
  degrade_model: z.string().max(256).nullable(),
  degrade_provider: z.string().max(256).nullable(),
  expected_version: z.number().int().positive().nullable().optional(),
}).strict();
const Disabled = z.object({ expected_version: z.number().int().positive() }).strict();
const NativeScope = Subject.extend({
  scope_type: z.enum(['project', 'run']), scope_id: Identifier,
  created_at: z.string().datetime({ offset: true }),
  owner_sub: Identifier.nullable(),
}).strict();

function authority(request: FastifyRequest, subject: z.infer<typeof Subject>) {
  if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401, 'BUDGET_APP_KEY_REQUIRED');
  const actorToken = readBillingActorHeader(request.headers['x-uoa-actor']);
  let userId: string;
  try {
    const candidate = decodeJwt(actorToken).sub;
    if (!candidate || candidate.length > 256) throw new Error('actor subject missing');
    userId = candidate;
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_BILLING_ACTOR');
  }
  // The decoded sub is used only to select the request tuple. verifyBillingActor
  // checks signature, issuer, audience, epoch, product, org and team before use.
  return { credential: request.billingAppKey, actorToken, request: {
    product: subject.product, organisationId: subject.organization_id,
    teamId: subject.team_id, userId,
  } };
}

export function registerBillingCreditBudgetRoutes(app: FastifyInstance): void {
  app.post(`${BILLING_CREDIT_BUDGET_LIST_PATH}/scopes`,
    { preHandler: [requireBillingLifecycleAppKey] }, async (request, reply) => {
      const body = NativeScope.parse(request.body);
      const result = await registerNativeBudgetScope(authority(request, body), body);
      reply.header('Cache-Control', 'private, no-store');
      return reply.code(201).send(result);
    });
  app.get(BILLING_CREDIT_BUDGET_LIST_PATH,
    { preHandler: [requireBillingLifecycleAppKey] }, async (request, reply) => {
      const query = Subject.parse(request.query);
      const result = await listCreditBudgets(authority(request, query));
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(result);
    });
  app.put(BILLING_CREDIT_BUDGET_LIST_PATH,
    { preHandler: [requireBillingLifecycleAppKey] }, async (request, reply) => {
      const body = Policy.parse(request.body);
      const result = await putCreditBudget(authority(request, body), body);
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(result);
    });
  app.delete(`${BILLING_CREDIT_BUDGET_LIST_PATH}/:policyId`,
    { preHandler: [requireBillingLifecycleAppKey] }, async (request, reply) => {
      const query = Subject.parse(request.query);
      const body = Disabled.parse(request.body);
      const params = z.object({ policyId: Identifier }).strict().parse(request.params);
      const result = await deleteCreditBudget(authority(request, query),
        params.policyId, body.expected_version);
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(result);
    });
}
