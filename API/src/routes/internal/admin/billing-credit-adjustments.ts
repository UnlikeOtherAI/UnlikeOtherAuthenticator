import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  createAdminCreditAdjustment,
  previewAdminCreditAdjustment,
} from '../../../services/billing-credit-admin-adjustment.service.js';
import { listAdminCreditAccounts } from '../../../services/billing-credit-admin-account.service.js';
import { AppError } from '../../../utils/errors.js';

const IdentifierSchema = z.string().trim().min(1).max(256);
const IdempotencyKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const CreditAccountParamsSchema = z.object({ creditAccountId: IdentifierSchema }).strict();
const CreditAccountQuerySchema = z
  .object({
    organisation_id: IdentifierSchema.optional(),
    team_id: IdentifierSchema.optional(),
    search: z.string().trim().min(1).max(256).optional(),
    cursor: z.string().trim().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const PreviewAdjustmentSchema = z
  .object({
    organisation_id: IdentifierSchema,
    team_id: IdentifierSchema,
    signed_credits: z
      .string()
      .trim()
      .max(40)
      .regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,5})?$/),
    reason: z.string().trim().min(1).max(1000),
    idempotency_key: IdempotencyKeySchema,
  })
  .strict();
const ConfirmAdjustmentSchema = z
  .object({ confirmation_token: z.string().trim().min(32).max(12_000) })
  .strict();

const creditAmountSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['credits', 'display', 'usd_equivalent'],
  properties: {
    credits: { type: 'string' },
    display: { type: 'string' },
    usd_equivalent: {
      type: 'object',
      additionalProperties: false,
      required: ['amount', 'currency', 'display'],
      properties: {
        amount: { type: 'string' },
        currency: { type: 'string', const: 'USD' },
        display: { type: 'string' },
      },
    },
  },
} as const;

const adjustmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'signed_credits', 'reason', 'idempotency_key', 'created_by', 'created_at'],
  properties: {
    id: { type: 'string' },
    signed_credits: creditAmountSchema,
    reason: { type: 'string' },
    idempotency_key: { type: 'string' },
    created_by: {
      type: 'object',
      additionalProperties: false,
      required: ['user_id', 'email', 'admin_domain'],
      properties: {
        user_id: { type: 'string' },
        email: { type: 'string' },
        admin_domain: { type: 'string' },
      },
    },
    created_at: { type: 'string' },
  },
} as const;

const accountSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'organisation',
    'team',
    'mode',
    'remaining_credits',
    'updated_at',
    'recent_adjustments',
  ],
  properties: {
    id: { type: 'string' },
    organisation: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name'],
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    },
    team: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name'],
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    },
    mode: { type: 'string', enum: ['test', 'live'] },
    remaining_credits: creditAmountSchema,
    updated_at: { type: 'string' },
    recent_adjustments: { type: 'array', items: adjustmentSchema },
  },
} as const;

const accountListSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['accounts', 'next_cursor', 'has_more'],
  properties: {
    accounts: { type: 'array', items: accountSchema },
    next_cursor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    has_more: { type: 'boolean' },
  },
} as const;

const automaticTopUpSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['generation', 'state', 'threshold_credits', 'refill_credits', 'consequence'],
  properties: {
    generation: { type: 'integer', minimum: 0 },
    state: {
      type: 'string',
      enum: ['disabled', 'active', 'paused', 'requires_action', 'needs_review'],
    },
    threshold_credits: { anyOf: [creditAmountSchema, { type: 'null' }] },
    refill_credits: { anyOf: [creditAmountSchema, { type: 'null' }] },
    consequence: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          enum: [
            'not_active',
            'configuration_incomplete',
            'remains_above_threshold',
            'crosses_below_threshold',
            'remains_below_threshold',
            'crosses_above_threshold',
          ],
        },
        message: { type: 'string' },
      },
    },
  },
} as const;

const previewResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'account',
    'current_credits',
    'signed_credits',
    'resulting_credits',
    'reason',
    'idempotency_key',
    'automatic_top_up',
    'expires_at',
    'confirmation_token',
  ],
  properties: {
    account: accountSchema,
    current_credits: creditAmountSchema,
    signed_credits: creditAmountSchema,
    resulting_credits: creditAmountSchema,
    reason: { type: 'string' },
    idempotency_key: { type: 'string' },
    automatic_top_up: automaticTopUpSchema,
    expires_at: { type: 'string' },
    confirmation_token: { type: 'string' },
  },
} as const;

const mutationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['account', 'adjustment', 'replayed'],
  properties: {
    account: accountSchema,
    adjustment: adjustmentSchema,
    replayed: { type: 'boolean' },
  },
} as const;

const adminRoute: RouteShorthandOptions = {
  preHandler: [requireAdminSuperuser],
  onSend: async (_request, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  },
};

function actor(request: FastifyRequest): { userId: string; email: string } {
  const userId = request.adminAccessTokenClaims?.userId?.trim();
  const email = request.adminAccessTokenClaims?.email?.trim();
  if (!userId || !email) {
    throw new AppError('FORBIDDEN', 403, 'ADMIN_ACTOR_REQUIRED');
  }
  return { userId, email };
}

export function registerInternalAdminBillingCreditAdjustmentRoutes(app: FastifyInstance): void {
  app.get(
    '/internal/admin/billing/credit-accounts',
    { ...adminRoute, schema: { response: { 200: accountListSchema } } },
    async (request) => {
      const query = CreditAccountQuerySchema.parse(request.query);
      return listAdminCreditAccounts({
        organisationId: query.organisation_id,
        teamId: query.team_id,
        search: query.search,
        cursor: query.cursor,
        limit: query.limit,
      });
    },
  );

  app.post(
    '/internal/admin/billing/credit-accounts/:creditAccountId/adjustment-preview',
    { ...adminRoute, schema: { response: { 200: previewResponseSchema } } },
    async (request) => {
      const { creditAccountId } = CreditAccountParamsSchema.parse(request.params);
      const body = PreviewAdjustmentSchema.parse(request.body);
      return previewAdminCreditAdjustment({
        creditAccountId,
        organisationId: body.organisation_id,
        teamId: body.team_id,
        signedCredits: body.signed_credits,
        reason: body.reason,
        idempotencyKey: body.idempotency_key,
        actor: actor(request),
      });
    },
  );

  app.post(
    '/internal/admin/billing/credit-accounts/:creditAccountId/adjustments',
    {
      ...adminRoute,
      schema: { response: { 200: mutationResponseSchema, 201: mutationResponseSchema } },
    },
    async (request, reply) => {
      const { creditAccountId } = CreditAccountParamsSchema.parse(request.params);
      const body = ConfirmAdjustmentSchema.parse(request.body);
      const result = await createAdminCreditAdjustment({
        creditAccountId,
        confirmationToken: body.confirmation_token,
        actor: actor(request),
      });
      return reply.status(result.replayed ? 200 : 201).send(result);
    },
  );
}
