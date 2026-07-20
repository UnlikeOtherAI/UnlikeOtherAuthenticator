import type { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

import {
  BILLING_CONSUMER_ACTION_SCHEMA_VERSION,
  type BillingCancellationPreviewV1,
} from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { loadBillingCancellationState } from './billing-cancellation-state.service.js';
import { getCanonicalBillingStatement } from './billing-statement.service.js';
import type { BillingSubscriptionRequest } from './billing-stripe-subscription.service.js';

export const BILLING_CANCELLATION_SCHEMA_VERSION = BILLING_CONSUMER_ACTION_SCHEMA_VERSION;
export const BILLING_CANCELLATION_PREVIEW_TTL_MS = 5 * 60 * 1000;

function opaqueValue(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function createBillingCancellationPreview(
  params: {
    request: BillingSubscriptionRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: {
    prisma?: PrismaClient;
    now?: () => Date;
    getStatement?: typeof getCanonicalBillingStatement;
    loadState?: typeof loadBillingCancellationState;
  },
): Promise<BillingCancellationPreviewV1> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const now = deps?.now?.() ?? new Date();
  const statement = await (deps?.getStatement ?? getCanonicalBillingStatement)(params, {
    prisma,
    now: () => now,
  });
  if (!statement.capabilities.can_cancel || !statement.subscription) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_CANCELLATION_NOT_AVAILABLE');
  }
  const state = await (deps?.loadState ?? loadBillingCancellationState)(
    {
      organisationId: params.request.organisationId,
      teamId: params.request.teamId,
    },
    { prisma },
  );
  const current = state.subscriptions.find(
    (subscription) =>
      subscription.id === statement.subscription?.id &&
      subscription.serviceId === params.credential.service.id,
  );
  if (!current) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CANCELLATION_STATE_CHANGED');
  }
  const directAccessByService = new Map(
    state.accesses
      .filter((access) => access.userIds.length > 0)
      .map((access) => [access.serviceId, access]),
  );
  if (!directAccessByService.has(current.serviceId)) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CANCELLATION_STATE_CHANGED');
  }
  const directSubscriptions = [current];
  const seenServiceIds = new Set([current.serviceId]);
  for (const subscription of state.subscriptions) {
    if (
      subscription.id === current.id ||
      subscription.accountId !== current.accountId ||
      !directAccessByService.has(subscription.serviceId) ||
      seenServiceIds.has(subscription.serviceId)
    ) {
      continue;
    }
    seenServiceIds.add(subscription.serviceId);
    directSubscriptions.push(subscription);
  }
  const related = directSubscriptions.slice(1);
  const choiceRequired = related.length > 0;
  const previewToken = opaqueValue('uoa_cancel');
  const idempotencyKey = opaqueValue('uoa_confirm');
  const expiresAt = new Date(now.getTime() + BILLING_CANCELLATION_PREVIEW_TTL_MS);
  const indirect = statement.services.filter((service) => service.access === 'indirect');

  await prisma.billingCancellationIntent.create({
    data: {
      tokenDigest: digest(previewToken),
      appKeyId: params.credential.id,
      serviceId: params.credential.service.id,
      orgId: params.request.organisationId,
      teamId: params.request.teamId,
      requestedByUserId: params.request.userId,
      directServiceIds: directSubscriptions.map((subscription) => subscription.serviceId),
      directSubscriptionIds: directSubscriptions.map((subscription) => subscription.id),
      indirectServiceIds: indirect.map((service) => service.product),
      entitlementFingerprint: state.entitlementFingerprint,
      subscriptionFingerprint: state.subscriptionFingerprint,
      expiresAt,
    },
  });

  return {
    schema_version: BILLING_CANCELLATION_SCHEMA_VERSION,
    preview_token: previewToken,
    expires_at: expiresAt.toISOString(),
    title: `Cancel ${params.credential.service.name}?`,
    message: choiceRequired
      ? 'Choose whether to cancel only this product or every related product your team accesses directly.'
      : indirect.length
        ? 'Only this direct subscription will be cancelled. Indirectly used services have no separate subscription to cancel.'
        : 'This subscription will be scheduled to end at its current period boundary.',
    choice_required: choiceRequired,
    choices: choiceRequired
      ? [
          {
            id: 'current_service',
            label: `Cancel ${params.credential.service.name} only`,
            description: 'Keep the team’s other direct product subscriptions active.',
            service_ids: [current.serviceId],
          },
          {
            id: 'current_and_related_direct_services',
            label: 'Cancel all related direct subscriptions',
            description: `Also cancel ${related.map((item) => item.service.name).join(', ')}.`,
            service_ids: directSubscriptions.map((item) => item.serviceId),
          },
        ]
      : [],
    direct_services: directSubscriptions.map((subscription) => {
      const access = directAccessByService.get(subscription.serviceId);
      return {
        service_id: subscription.serviceId,
        product: subscription.service.identifier,
        name: subscription.service.name,
        display_name: subscription.service.name,
        direct_user_count: access?.userIds.length ?? 0,
        subscription_status: subscription.status,
      };
    }),
    indirect_services: indirect.map((service) => ({
      product: service.product,
      name: service.name,
      display_name: service.display_name,
      impact: 'No separate subscription will be cancelled.',
    })),
    confirm_action: {
      method: 'POST',
      path: '/billing/v1/cancellation/confirm',
      label: 'Confirm cancellation',
      idempotency_key: idempotencyKey,
      selection_required: choiceRequired,
      default_selection: choiceRequired ? null : 'current_service',
    },
  };
}
