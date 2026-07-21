import {
  BillingAssignmentScope,
  BillingRecurringAddonCancellationIntentState,
  BillingRecurringAddonEntitlementScope,
  BillingRecurringAddonSubscriptionScope,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import type Stripe from 'stripe';

import {
  BILLING_RECURRING_ADDONS_CANCELLATION_CONFIRM_PATH,
  BILLING_RECURRING_ADDONS_SCHEMA_VERSION,
  type BillingRecurringAddonCancellationPreviewV1,
} from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { resolveEffectiveTariffContext } from './billing-entitlement.service.js';
import { resolveBillingFundingViewer } from './billing-funding-viewer.service.js';
import {
  assertCanManageRecurringAddonScope,
  recurringAddonSubjectFingerprint,
  type RecurringAddonScope,
  type RecurringAddonSubject,
} from './billing-recurring-addon-scope.service.js';
import {
  requireStripeBillingEnabled,
  resolveStripeAccountContext,
} from './billing-stripe-client.service.js';
import {
  refreshRecurringAddonSubscriptionProjection,
  recurringAddonSubscriptionInclude,
  type RecurringAddonSubscriptionClient,
  type RecurringAddonSubscriptionWithBinding,
} from './billing-recurring-addon-subscription.service.js';

export const RECURRING_ADDON_CANCELLATION_TTL_MS = 5 * 60 * 1000;

function opaque(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function recurringAddonCancellationDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function scopeForSubscription(
  subscription: RecurringAddonSubscriptionWithBinding,
): RecurringAddonScope {
  const teamCustomer = subscription.scope !== BillingRecurringAddonSubscriptionScope.ORGANISATION;
  return {
    scope: subscription.scope,
    scopeKey: subscription.scopeKey,
    teamId: subscription.teamId,
    subscribingUserId: subscription.subscribingUserId,
    customerScope: teamCustomer ? BillingAssignmentScope.TEAM : BillingAssignmentScope.ORGANISATION,
    customerScopeKey: teamCustomer
      ? `${subscription.orgId}:${subscription.teamId}`
      : subscription.orgId,
    customerTeamId: teamCustomer ? subscription.teamId : null,
  };
}

function expectedEntitlementScope(
  scope: BillingRecurringAddonSubscriptionScope,
): BillingRecurringAddonEntitlementScope {
  if (scope === BillingRecurringAddonSubscriptionScope.ORGANISATION) {
    return BillingRecurringAddonEntitlementScope.ORGANISATION;
  }
  return scope === BillingRecurringAddonSubscriptionScope.TEAM
    ? BillingRecurringAddonEntitlementScope.TEAM
    : BillingRecurringAddonEntitlementScope.SUBSCRIBING_USER;
}

export function assertCurrentSubscriptionPolicy(
  subscription: RecurringAddonSubscriptionWithBinding,
): void {
  if (
    !subscription.offer.featurePolicies.some(
      (policy) => policy.entitlementScope === expectedEntitlementScope(subscription.scope),
    ) ||
    subscription.catalog.currency !== subscription.offer.currency ||
    subscription.catalog.monthlyAmountMinor !== subscription.offer.monthlyAmountMinor
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_RECURRING_ADDON_POLICY_CHANGED');
  }
}

export async function loadAuthorizedRecurringAddonSubscription(
  params: {
    request: RecurringAddonSubject;
    subscriptionId: string;
    credential: VerifiedBillingAppKey;
  },
  deps: { prisma: PrismaClient },
): Promise<RecurringAddonSubscriptionWithBinding> {
  const subscription = await deps.prisma.billingRecurringAddonSubscription.findFirst({
    where: {
      id: params.subscriptionId,
      serviceId: params.credential.service.id,
      orgId: params.request.organisationId,
      OR: [
        { scope: BillingRecurringAddonSubscriptionScope.ORGANISATION, teamId: null },
        { teamId: params.request.teamId },
      ],
    },
    include: recurringAddonSubscriptionInclude,
  });
  if (!subscription) {
    throw new AppError('NOT_FOUND', 404, 'BILLING_RECURRING_ADDON_SUBSCRIPTION_NOT_FOUND');
  }
  assertCurrentSubscriptionPolicy(subscription);
  return subscription;
}

export async function createRecurringAddonCancellationPreview(
  params: {
    request: RecurringAddonSubject & { subscriptionId: string };
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: {
    prisma?: PrismaClient;
    stripe?: RecurringAddonSubscriptionClient & Pick<Stripe, 'accounts'>;
    stripeLivemode?: boolean;
    now?: () => Date;
  },
): Promise<BillingRecurringAddonCancellationPreviewV1> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const { actor } = await resolveEffectiveTariffContext(
    { request: params.request, actorToken: params.actorToken, credential: params.credential },
    { prisma },
  );
  const viewer = await resolveBillingFundingViewer(params.request, { prisma });
  let subscription = await loadAuthorizedRecurringAddonSubscription(
    {
      request: params.request,
      subscriptionId: params.request.subscriptionId,
      credential: params.credential,
    },
    { prisma },
  );
  assertCanManageRecurringAddonScope(viewer, subscription.scope);

  const configured = deps?.stripe ? undefined : requireStripeBillingEnabled();
  const stripe = deps?.stripe ?? configured?.client;
  if (!stripe) throw new AppError('INTERNAL', 503, 'STRIPE_BILLING_DISABLED');
  const account = await resolveStripeAccountContext(
    stripe,
    deps?.stripeLivemode ?? configured?.livemode ?? false,
    prisma,
  );
  if (subscription.accountId !== account.id) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_ACCOUNT_DRIFT');
  }
  const refreshed = await refreshRecurringAddonSubscriptionProjection(
    { local: subscription, account, now: deps?.now?.() },
    { prisma, stripe },
  );
  subscription = refreshed.local;
  if (
    !refreshed.remote ||
    ['canceled', 'incomplete_expired'].includes(subscription.status) ||
    subscription.cancelAtPeriodEnd
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_RECURRING_ADDON_CANCELLATION_UNAVAILABLE');
  }

  const now = deps?.now?.() ?? new Date();
  const previewToken = opaque('uoa_addon_cancel');
  const idempotencyKey = opaque('uoa_addon_confirm');
  const expiresAt = new Date(now.getTime() + RECURRING_ADDON_CANCELLATION_TTL_MS);
  const scope = scopeForSubscription(subscription);
  const subjectFingerprint = recurringAddonSubjectFingerprint({
    appKeyId: params.credential.id,
    serviceId: params.credential.service.id,
    offerId: subscription.offerId,
    subject: params.request,
    scope,
  });
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.billingRecurringAddonCancellationIntent.updateMany({
          where: {
            subscriptionId: subscription.id,
            state: BillingRecurringAddonCancellationIntentState.AVAILABLE,
            expiresAt: { lte: now },
          },
          data: { state: BillingRecurringAddonCancellationIntentState.EXPIRED },
        });
        await tx.billingRecurringAddonCancellationIntent.create({
          data: {
            accountId: account.id,
            appKeyId: params.credential.id,
            subscriptionId: subscription.id,
            serviceId: subscription.serviceId,
            offerId: subscription.offerId,
            orgId: subscription.orgId,
            teamId: subscription.teamId,
            requestedTeamId: params.request.teamId,
            subscribingUserId: subscription.subscribingUserId,
            scope: subscription.scope,
            scopeKey: subscription.scopeKey,
            requestedByUserId: params.request.userId,
            actorJti: actor.jti,
            tokenDigest: recurringAddonCancellationDigest(previewToken),
            subjectFingerprint,
            idempotencyKey,
            expiresAt,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'P2002') {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_RECURRING_ADDON_PREVIEW_EXISTS');
    }
    throw error;
  }
  return {
    schema_version: BILLING_RECURRING_ADDONS_SCHEMA_VERSION,
    preview_token: previewToken,
    idempotency_key: idempotencyKey,
    expires_at: expiresAt.toISOString(),
    title: `Cancel ${subscription.offer.name}?`,
    description: 'The paid add-on will remain available until the current period ends.',
    subscription: {
      id: subscription.id,
      offer_name: subscription.offer.name,
      display_status: subscription.cancelAtPeriodEnd
        ? 'Cancels at period end'
        : subscription.status.replaceAll('_', ' '),
      cancellation_effective_at: subscription.currentPeriodEnd?.toISOString() ?? null,
    },
    confirm_action: {
      method: 'POST',
      path: BILLING_RECURRING_ADDONS_CANCELLATION_CONFIRM_PATH,
      body: {
        product: params.credential.service.identifier,
        organisation_id: params.request.organisationId,
        team_id: params.request.teamId,
        user_id: params.request.userId,
        preview_token: previewToken,
        idempotency_key: idempotencyKey,
        choice: 'cancel_addon',
      },
    },
  };
}
