import {
  BillingAssignmentScope,
  BillingCancellationIntentState,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import type Stripe from 'stripe';

import type {
  BillingCancellationConfirmationV1,
  BillingCancellationSelection,
} from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  authorizeBillingCustomerAction,
  BILLING_CUSTOMER_ACTION,
} from './billing-customer-action-intent.service.js';
import { resolveEffectiveTariffContext } from './billing-entitlement.service.js';
import {
  loadBillingCancellationState,
  type CancellationSubscription,
} from './billing-cancellation-state.service.js';
import { BILLING_CANCELLATION_SCHEMA_VERSION } from './billing-cancellation-preview.service.js';
import {
  assertStripeObjectLivemode,
  requireStripeBillingEnabled,
  resolveStripeAccountContext,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import {
  getStripeSubscriptionSummary,
  type BillingSubscriptionRequest,
} from './billing-stripe-subscription.service.js';
import { syncStripeSubscriptionProjection } from './billing-stripe-webhook.service.js';

type StripeCancellationClient = Pick<Stripe, 'accounts' | 'subscriptions'>;
type SubscriptionSummary = Awaited<ReturnType<typeof getStripeSubscriptionSummary>>;

type ClaimResult =
  | { completed: BillingCancellationConfirmationV1 }
  | {
      intentId: string;
      targets: CancellationSubscription[];
      indirectProducts: string[];
    };

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requestDigest(selection: BillingCancellationSelection | null): string {
  return digest(JSON.stringify({ selection }));
}

function assertIntentBinding(
  intent: {
    appKeyId: string;
    serviceId: string;
    orgId: string;
    teamId: string;
    requestedByUserId: string;
  },
  params: {
    request: BillingSubscriptionRequest;
    credential: VerifiedBillingAppKey;
  },
): void {
  if (
    intent.appKeyId !== params.credential.id ||
    intent.serviceId !== params.credential.service.id ||
    intent.orgId !== params.request.organisationId ||
    intent.teamId !== params.request.teamId ||
    intent.requestedByUserId !== params.request.userId
  ) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_CANCELLATION_TOKEN_INVALID');
  }
}

function selectedServiceIds(
  directServiceIds: string[],
  currentServiceId: string,
  selection: BillingCancellationSelection | null,
): string[] {
  const choiceRequired = directServiceIds.length > 1;
  if (choiceRequired && !selection) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CANCELLATION_CHOICE_REQUIRED');
  }
  if (!choiceRequired && selection === 'current_and_related_direct_services') {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CANCELLATION_CHOICE_NOT_ALLOWED');
  }
  return selection === 'current_and_related_direct_services'
    ? directServiceIds
    : [currentServiceId];
}

function parseStoredResult(value: Prisma.JsonValue): BillingCancellationConfirmationV1 {
  const candidate = value as Partial<BillingCancellationConfirmationV1> | null;
  if (
    !candidate ||
    candidate.schema_version !== BILLING_CANCELLATION_SCHEMA_VERSION ||
    candidate.status !== 'confirmed' ||
    !Array.isArray(candidate.cancelled_services) ||
    !Array.isArray(candidate.indirect_services) ||
    typeof candidate.title !== 'string' ||
    typeof candidate.message !== 'string'
  ) {
    throw new AppError('INTERNAL', 500, 'BILLING_CANCELLATION_RESULT_INVALID');
  }
  return candidate as BillingCancellationConfirmationV1;
}

async function claimCancellation(
  params: {
    request: BillingSubscriptionRequest;
    credential: VerifiedBillingAppKey;
    token: string;
    idempotencyKey: string;
    selection: BillingCancellationSelection | null;
    currentSubscriptionId: string;
    now: Date;
    authorizeAction: (tx: Prisma.TransactionClient) => Promise<void>;
  },
  prisma: PrismaClient,
  loadState: typeof loadBillingCancellationState,
): Promise<ClaimResult> {
  const tokenDigest = digest(params.token);
  const payloadDigest = requestDigest(params.selection);
  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT "id"
          FROM "billing_cancellation_intents"
          WHERE "token_digest" = ${tokenDigest}
          FOR UPDATE
        `,
      );
      if (locked.length !== 1) {
        throw new AppError('NOT_FOUND', 404, 'BILLING_CANCELLATION_TOKEN_INVALID');
      }
      const intent = await tx.billingCancellationIntent.findUnique({
        where: { id: locked[0]?.id },
      });
      if (!intent) {
        throw new AppError('NOT_FOUND', 404, 'BILLING_CANCELLATION_TOKEN_INVALID');
      }
      assertIntentBinding(intent, params);
      if (intent.state === BillingCancellationIntentState.COMPLETED) {
        if (
          intent.idempotencyKey !== params.idempotencyKey ||
          intent.requestDigest !== payloadDigest ||
          intent.result === null
        ) {
          throw new AppError('BAD_REQUEST', 409, 'BILLING_CANCELLATION_ALREADY_USED');
        }
        return { completed: parseStoredResult(intent.result) };
      }
      if (
        intent.state === BillingCancellationIntentState.PROCESSING &&
        (intent.idempotencyKey !== params.idempotencyKey || intent.requestDigest !== payloadDigest)
      ) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_CANCELLATION_ALREADY_USED');
      }
      if (
        intent.state === BillingCancellationIntentState.AVAILABLE &&
        intent.expiresAt <= params.now
      ) {
        throw new AppError('BAD_REQUEST', 410, 'BILLING_CANCELLATION_TOKEN_EXPIRED');
      }
      if (
        intent.directServiceIds.length === 0 ||
        intent.directServiceIds.length !== intent.directSubscriptionIds.length ||
        new Set(intent.directServiceIds).size !== intent.directServiceIds.length ||
        new Set(intent.directSubscriptionIds).size !== intent.directSubscriptionIds.length
      ) {
        throw new AppError('INTERNAL', 500, 'BILLING_CANCELLATION_INTENT_INVALID');
      }

      const targetServiceIds = selectedServiceIds(
        intent.directServiceIds,
        params.credential.service.id,
        params.selection,
      );
      const state = await loadState(
        {
          organisationId: params.request.organisationId,
          teamId: params.request.teamId,
        },
        { prisma: tx },
      );
      if (
        intent.state === BillingCancellationIntentState.AVAILABLE &&
        (state.entitlementFingerprint !== intent.entitlementFingerprint ||
          state.subscriptionFingerprint !== intent.subscriptionFingerprint)
      ) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_CANCELLATION_STATE_CHANGED');
      }
      const current = state.subscriptions.find(
        (subscription) =>
          subscription.id === params.currentSubscriptionId &&
          subscription.serviceId === params.credential.service.id &&
          intent.directSubscriptionIds.includes(subscription.id),
      );
      if (!current) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_CANCELLATION_STATE_CHANGED');
      }
      const targets = targetServiceIds.map((serviceId) => {
        const pinnedIndex = intent.directServiceIds.indexOf(serviceId);
        const pinnedSubscriptionId = intent.directSubscriptionIds[pinnedIndex];
        if (!pinnedSubscriptionId) {
          throw new AppError('INTERNAL', 500, 'BILLING_CANCELLATION_INTENT_INVALID');
        }
        const target = state.subscriptions.find(
          (subscription) =>
            subscription.id === pinnedSubscriptionId &&
            subscription.serviceId === serviceId &&
            subscription.accountId === current.accountId,
        );
        if (!target) {
          throw new AppError('BAD_REQUEST', 409, 'BILLING_CANCELLATION_STATE_CHANGED');
        }
        return target;
      });
      if (intent.state === BillingCancellationIntentState.AVAILABLE) {
        await params.authorizeAction(tx);
        await tx.billingCancellationIntent.update({
          where: { id: intent.id },
          data: {
            state: BillingCancellationIntentState.PROCESSING,
            idempotencyKey: params.idempotencyKey,
            requestDigest: payloadDigest,
            consumedAt: params.now,
          },
        });
      }
      return {
        intentId: intent.id,
        targets,
        indirectProducts: intent.indirectServiceIds,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function cancelTargets(
  targets: CancellationSubscription[],
  deps: {
    operationId: string;
    prisma: PrismaClient;
    stripe: StripeCancellationClient;
    account: StripeAccountContext;
    syncSubscription: typeof syncStripeSubscriptionProjection;
  },
): Promise<CancellationSubscription[]> {
  for (const target of targets) {
    if (target.accountId !== deps.account.id || target.livemode !== deps.account.livemode) {
      throw new AppError('BAD_REQUEST', 409, 'STRIPE_ACCOUNT_MISMATCH');
    }
    const remote = await deps.stripe.subscriptions.update(
      target.stripeSubscriptionId,
      { cancel_at_period_end: true },
      { idempotencyKey: `uoa_cancel_${deps.operationId}_${target.id}` },
    );
    assertStripeObjectLivemode(remote, deps.account.livemode);
    await deps.syncSubscription(
      { subscription: remote, account: deps.account },
      { prisma: deps.prisma },
    );
  }
  const refreshed = await deps.prisma.billingStripeSubscription.findMany({
    where: { id: { in: targets.map((target) => target.id) } },
    include: {
      service: { select: { id: true, identifier: true, name: true } },
      account: { select: { id: true, stripeAccountId: true, livemode: true } },
    },
    orderBy: { serviceId: 'asc' },
  });
  if (
    refreshed.length !== targets.length ||
    refreshed.some((subscription) => !subscription.cancelAtPeriodEnd)
  ) {
    throw new AppError('INTERNAL', 502, 'BILLING_CANCELLATION_RECONCILIATION_FAILED');
  }
  return refreshed;
}

function confirmationResult(
  subscriptions: CancellationSubscription[],
  indirectProducts: string[],
): BillingCancellationConfirmationV1 {
  return {
    schema_version: BILLING_CANCELLATION_SCHEMA_VERSION,
    status: 'confirmed',
    title: 'Cancellation scheduled',
    message:
      subscriptions.length === 1
        ? 'The subscription will end at its current period boundary.'
        : `${subscriptions.length} direct subscriptions will end at their current period boundaries.`,
    cancelled_services: subscriptions.map((subscription) => ({
      service_id: subscription.serviceId,
      product: subscription.service.identifier,
      name: subscription.service.name,
      display_name: subscription.service.name,
      status: 'cancels_at_period_end',
      effective_at: subscription.currentPeriodEnd?.toISOString() ?? null,
    })),
    indirect_services: indirectProducts.sort().map((product) => ({
      product,
      display_name: product,
      impact: 'No separate subscription was cancelled.',
    })),
  };
}

export async function confirmBillingCancellation(
  params: {
    request: BillingSubscriptionRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
    token: string;
    idempotencyKey: string;
    selection: BillingCancellationSelection | null;
  },
  deps?: {
    prisma?: PrismaClient;
    stripe?: StripeCancellationClient;
    stripeLivemode?: boolean;
    now?: () => Date;
    loadState?: typeof loadBillingCancellationState;
    resolveAccount?: typeof resolveStripeAccountContext;
    syncSubscription?: typeof syncStripeSubscriptionProjection;
    resolveTariff?: typeof resolveEffectiveTariffContext;
    authorizeAction?: typeof authorizeBillingCustomerAction;
    resolveSummary?: (
      params: Pick<
        Parameters<typeof getStripeSubscriptionSummary>[0],
        'request' | 'actorToken' | 'credential'
      >,
    ) => Promise<SubscriptionSummary>;
  },
): Promise<BillingCancellationConfirmationV1> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const summary = await (
    deps?.resolveSummary ?? ((context) => getStripeSubscriptionSummary(context, { prisma }))
  )(params);
  if (!summary.can_manage || !summary.subscription) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_CANCELLATION_NOT_AVAILABLE');
  }
  const subscription = summary.subscription;
  const { actor } = await (deps?.resolveTariff ?? resolveEffectiveTariffContext)(params, {
    prisma,
  });
  const claimed = await claimCancellation(
    {
      ...params,
      currentSubscriptionId: subscription.id,
      now: deps?.now?.() ?? new Date(),
      authorizeAction: async (tx) => {
        await (deps?.authorizeAction ?? authorizeBillingCustomerAction)(
          {
            credential: params.credential,
            organisationId: params.request.organisationId,
            teamId: params.request.teamId,
            userId: params.request.userId,
            authorityScope:
              subscription.scope === 'organisation'
                ? BillingAssignmentScope.ORGANISATION
                : BillingAssignmentScope.TEAM,
            operation: BILLING_CUSTOMER_ACTION.SUBSCRIPTION_CANCEL,
            actor,
            request: {
              product: params.request.product,
              organisation_id: params.request.organisationId,
              team_id: params.request.teamId,
              user_id: params.request.userId,
              subscription_id: subscription.id,
              preview_token_digest: digest(params.token),
              idempotency_key_digest: digest(params.idempotencyKey),
              selection: params.selection,
            },
          },
          { prisma: tx },
        );
      },
    },
    prisma,
    deps?.loadState ?? loadBillingCancellationState,
  );
  if ('completed' in claimed) return claimed.completed;

  const configured = deps?.stripe ? undefined : requireStripeBillingEnabled();
  const stripe = deps?.stripe ?? configured?.client;
  if (!stripe) throw new AppError('INTERNAL', 503, 'STRIPE_BILLING_DISABLED');
  const account = await (deps?.resolveAccount ?? resolveStripeAccountContext)(
    stripe,
    deps?.stripeLivemode ?? configured?.livemode ?? false,
    prisma,
  );
  const cancelled = await cancelTargets(claimed.targets, {
    operationId: claimed.intentId,
    prisma,
    stripe,
    account,
    syncSubscription: deps?.syncSubscription ?? syncStripeSubscriptionProjection,
  });
  const result = confirmationResult(cancelled, claimed.indirectProducts);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.billingCancellationIntent.updateMany({
      where: {
        id: claimed.intentId,
        state: BillingCancellationIntentState.PROCESSING,
        idempotencyKey: params.idempotencyKey,
        requestDigest: requestDigest(params.selection),
      },
      data: {
        state: BillingCancellationIntentState.COMPLETED,
        result: result as unknown as Prisma.InputJsonValue,
      },
    });
    if (updated.count !== 1) {
      const completed = await tx.billingCancellationIntent.findUnique({
        where: { id: claimed.intentId },
      });
      if (
        completed?.state === BillingCancellationIntentState.COMPLETED &&
        completed.idempotencyKey === params.idempotencyKey &&
        completed.requestDigest === requestDigest(params.selection) &&
        completed.result !== null
      ) {
        return parseStoredResult(completed.result);
      }
      throw new AppError('BAD_REQUEST', 409, 'BILLING_CANCELLATION_STATE_CHANGED');
    }
    await tx.orgAuditLog.create({
      data: {
        orgId: params.request.organisationId,
        actorUserId: params.request.userId,
        action: 'billing.subscription_cancellation_confirmed',
        targetType: 'billing_cancellation_intent',
        targetId: claimed.intentId,
        metadata: {
          product: params.credential.service.identifier,
          service_ids: cancelled.map((subscription) => subscription.serviceId),
        },
      },
    });
    return result;
  });
}
