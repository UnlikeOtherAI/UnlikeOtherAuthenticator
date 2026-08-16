import type { FastifyInstance, FastifyRequest } from 'fastify';

import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import { BillingOrgResponsibilityBlockedError } from '../../services/billing-org-responsibility-guard.service.js';
import {
  assumeOrgBillingResponsibility,
  readOrgBillingResponsibility,
  releaseOrgBillingResponsibility,
} from '../../services/billing-org-responsibility-lifecycle.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from './billing-request.js';

export const BILLING_ORG_RESPONSIBILITY_READ_PATH = '/billing/v1/organisation-billing' as const;
export const BILLING_ORG_RESPONSIBILITY_ASSUME_PATH =
  '/billing/v1/organisation-billing/assume' as const;
export const BILLING_ORG_RESPONSIBILITY_RELEASE_PATH =
  '/billing/v1/organisation-billing/release' as const;

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['organisation_id', 'active', 'assumed_at', 'released_at'],
  properties: {
    organisation_id: { type: 'string' },
    active: { type: 'boolean' },
    assumed_at: { type: ['string', 'null'] },
    released_at: { type: ['string', 'null'] },
    deactivated_team_auto_top_ups: { type: 'integer' },
    can_manage: { type: 'boolean' },
  },
} as const;

const blockedSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error', 'funding_actions_in_flight', 'team_subscriptions'],
  properties: {
    error: { type: 'string', enum: ['FUNDING_ACTION_IN_FLIGHT', 'TEAM_SUBSCRIPTIONS_ACTIVE'] },
    funding_actions_in_flight: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'id'],
        properties: { kind: { type: 'string' }, id: { type: 'string' } },
      },
    },
    team_subscriptions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subscription_id', 'service_id', 'scope_key', 'status'],
        properties: {
          subscription_id: { type: 'string' },
          service_id: { type: 'string' },
          scope_key: { type: 'string' },
          status: { type: 'string' },
        },
      },
    },
  },
} as const;

/**
 * A blocked assumption says exactly what is in the way. The reason code is the
 * contract (`TEAM_SUBSCRIPTIONS_ACTIVE` is named in the design); the lists
 * exist so an operator can go and settle the specific rows rather than guess.
 */
function blockedBody(error: BillingOrgResponsibilityBlockedError) {
  return {
    error: error.reason,
    funding_actions_in_flight: error.blockers.map((blocker) => ({
      kind: blocker.kind,
      id: blocker.id,
    })),
    team_subscriptions: error.subscriptions.map((subscription) => ({
      subscription_id: subscription.subscriptionId,
      service_id: subscription.serviceId,
      scope_key: subscription.scopeKey,
      status: subscription.status,
    })),
  };
}

export function registerBillingOrgResponsibilityRoutes(app: FastifyInstance): void {
  const parse = (request: FastifyRequest) => {
    const body = BillingSubjectRequestSchema.parse(request.body);
    const credential = request.billingAppKey;
    if (!credential) throw new AppError('UNAUTHORIZED', 401);
    return {
      credential,
      actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
      request: {
        product: body.product,
        organisationId: body.organisation_id,
        teamId: body.team_id,
        userId: body.user_id,
      },
    };
  };

  app.post(
    BILLING_ORG_RESPONSIBILITY_READ_PATH,
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: { response: { 200: responseSchema } },
    },
    async (request, reply) => {
      const state = await readOrgBillingResponsibility(parse(request));
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(state);
    },
  );

  app.post(
    BILLING_ORG_RESPONSIBILITY_ASSUME_PATH,
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: { response: { 200: responseSchema, 409: blockedSchema } },
    },
    async (request, reply) => {
      try {
        const state = await assumeOrgBillingResponsibility(parse(request));
        reply.header('Cache-Control', 'private, no-store');
        return reply.send(state);
      } catch (error) {
        if (error instanceof BillingOrgResponsibilityBlockedError) {
          reply.header('Cache-Control', 'private, no-store');
          return reply.status(409).send(blockedBody(error));
        }
        throw error;
      }
    },
  );

  app.post(
    BILLING_ORG_RESPONSIBILITY_RELEASE_PATH,
    {
      preHandler: [requireBillingLifecycleAppKey],
      schema: { response: { 200: responseSchema } },
    },
    async (request, reply) => {
      const state = await releaseOrgBillingResponsibility(parse(request));
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(state);
    },
  );
}
