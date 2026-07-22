import {
  BillingRecurringAddonCancellationIntentState,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import type Stripe from 'stripe';

import {
  BILLING_RECURRING_ADDONS_SCHEMA_VERSION,
  type BillingRecurringAddonCancellationConfirmationV1,
} from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  authorizeBillingCustomerAction,
  BILLING_CUSTOMER_ACTION,
} from './billing-customer-action-intent.service.js';
import {
  assertCurrentSubscriptionPolicy,
  recurringAddonCancellationDigest,
  scopeForSubscription,
} from './billing-recurring-addon-cancellation-preview.service.js';
import { resolveEffectiveTariffContext } from './billing-entitlement.service.js';
import { resolveBillingFundingViewer } from './billing-funding-viewer.service.js';
import {
  assertCanManageRecurringAddonScope,
  recurringAddonSubjectFingerprint,
  type RecurringAddonSubject,
} from './billing-recurring-addon-scope.service.js';
import {
  requireStripeBillingEnabled,
  resolveStripeAccountContext,
} from './billing-stripe-client.service.js';
import {
  refreshRecurringAddonSubscriptionProjection,
  recurringAddonSubscriptionInclude,
  syncRecurringAddonSubscriptionProjection,
  type RecurringAddonSubscriptionClient,
  type RecurringAddonSubscriptionWithBinding,
} from './billing-recurring-addon-subscription.service.js';

type ConfirmationRequest = RecurringAddonSubject & {
  previewToken: string;
  idempotencyKey: string;
  choice: 'cancel_addon';
};

type Claim =
  | { kind: 'completed'; result: BillingRecurringAddonCancellationConfirmationV1 }
  | { kind: 'expired' }
  | {
      kind: 'active';
      intentId: string;
      subscription: RecurringAddonSubscriptionWithBinding;
    };

function confirmationRequestDigest(request: ConfirmationRequest): string {
  return recurringAddonCancellationDigest(
    JSON.stringify({
      product: request.product,
      organisation_id: request.organisationId,
      team_id: request.teamId,
      user_id: request.userId,
      preview_token_digest: recurringAddonCancellationDigest(request.previewToken),
      idempotency_key: request.idempotencyKey,
      choice: request.choice,
    }),
  );
}

function parseResult(value: Prisma.JsonValue): BillingRecurringAddonCancellationConfirmationV1 {
  const result = value as Partial<BillingRecurringAddonCancellationConfirmationV1> | null;
  if (
    !result ||
    result.schema_version !== BILLING_RECURRING_ADDONS_SCHEMA_VERSION ||
    !['scheduled', 'already_scheduled'].includes(result.status ?? '') ||
    typeof result.title !== 'string' ||
    typeof result.description !== 'string' ||
    (result.cancellation_effective_at !== null &&
      typeof result.cancellation_effective_at !== 'string')
  ) {
    throw new AppError('INTERNAL', 500, 'BILLING_RECURRING_ADDON_RESULT_INVALID');
  }
  return result as BillingRecurringAddonCancellationConfirmationV1;
}

function assertIntentBinding(
  intent: {
    appKeyId: string;
    serviceId: string;
    orgId: string;
    requestedTeamId: string;
    requestedByUserId: string;
    idempotencyKey: string;
    subjectFingerprint: string;
  },
  params: {
    request: ConfirmationRequest;
    credential: VerifiedBillingAppKey;
    subjectFingerprint: string;
  },
): void {
  if (
    intent.appKeyId !== params.credential.id ||
    intent.serviceId !== params.credential.service.id ||
    intent.orgId !== params.request.organisationId ||
    intent.requestedTeamId !== params.request.teamId ||
    intent.requestedByUserId !== params.request.userId ||
    intent.idempotencyKey !== params.request.idempotencyKey ||
    intent.subjectFingerprint !== params.subjectFingerprint
  ) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_RECURRING_ADDON_CANCELLATION_TOKEN_INVALID');
  }
}

async function claimCancellation(
  params: {
    tokenDigest: string;
    requestDigest: string;
    request: ConfirmationRequest;
    credential: VerifiedBillingAppKey;
    subjectFingerprint: string;
    now: Date;
  },
  prisma: PrismaClient,
): Promise<Claim> {
  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT "id"
          FROM "billing_recurring_addon_cancellation_intents"
          WHERE "token_digest" = ${params.tokenDigest}
          FOR UPDATE
        `,
      );
      const id = locked[0]?.id;
      if (!id) {
        throw new AppError('NOT_FOUND', 404, 'BILLING_RECURRING_ADDON_CANCELLATION_TOKEN_INVALID');
      }
      const intent = await tx.billingRecurringAddonCancellationIntent.findUnique({
        where: { id },
        include: { subscription: { include: recurringAddonSubscriptionInclude } },
      });
      if (!intent) {
        throw new AppError('NOT_FOUND', 404, 'BILLING_RECURRING_ADDON_CANCELLATION_TOKEN_INVALID');
      }
      assertIntentBinding(intent, params);
      if (intent.state === BillingRecurringAddonCancellationIntentState.COMPLETED) {
        if (intent.confirmationRequestDigest !== params.requestDigest || !intent.result) {
          throw new AppError('BAD_REQUEST', 409, 'BILLING_RECURRING_ADDON_CANCELLATION_USED');
        }
        return { kind: 'completed', result: parseResult(intent.result) };
      }
      if (intent.state === BillingRecurringAddonCancellationIntentState.EXPIRED) {
        return { kind: 'expired' };
      }
      if (
        intent.state === BillingRecurringAddonCancellationIntentState.PROCESSING &&
        intent.confirmationRequestDigest !== params.requestDigest
      ) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_RECURRING_ADDON_CANCELLATION_USED');
      }
      if (
        intent.state === BillingRecurringAddonCancellationIntentState.AVAILABLE &&
        intent.expiresAt <= params.now
      ) {
        await tx.billingRecurringAddonCancellationIntent.update({
          where: { id: intent.id },
          data: { state: BillingRecurringAddonCancellationIntentState.EXPIRED },
        });
        return { kind: 'expired' };
      }
      if (intent.state === BillingRecurringAddonCancellationIntentState.AVAILABLE) {
        await tx.billingRecurringAddonCancellationIntent.update({
          where: { id: intent.id },
          data: {
            state: BillingRecurringAddonCancellationIntentState.PROCESSING,
            confirmationRequestDigest: params.requestDigest,
          },
        });
      }
      return { kind: 'active', intentId: intent.id, subscription: intent.subscription };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

function resultFor(
  subscription: RecurringAddonSubscriptionWithBinding,
  alreadyScheduled: boolean,
): BillingRecurringAddonCancellationConfirmationV1 {
  return {
    schema_version: BILLING_RECURRING_ADDONS_SCHEMA_VERSION,
    status: alreadyScheduled ? 'already_scheduled' : 'scheduled',
    title: alreadyScheduled ? 'Cancellation already scheduled' : 'Cancellation scheduled',
    description: 'The paid add-on remains available until its current period ends.',
    cancellation_effective_at: subscription.currentPeriodEnd?.toISOString() ?? null,
  };
}

export async function confirmRecurringAddonCancellation(
  params: {
    request: ConfirmationRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: {
    prisma?: PrismaClient;
    stripe?: RecurringAddonSubscriptionClient & Pick<Stripe, 'accounts'>;
    stripeLivemode?: boolean;
    now?: () => Date;
    authorizeAction?: typeof authorizeBillingCustomerAction;
  },
): Promise<BillingRecurringAddonCancellationConfirmationV1> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const { actor } = await resolveEffectiveTariffContext(
    { request: params.request, actorToken: params.actorToken, credential: params.credential },
    { prisma },
  );
  const viewer = await resolveBillingFundingViewer(params.request, { prisma });
  const tokenDigest = recurringAddonCancellationDigest(params.request.previewToken);
  const initialIntent = await prisma.billingRecurringAddonCancellationIntent.findUnique({
    where: { tokenDigest },
    include: { subscription: { include: recurringAddonSubscriptionInclude } },
  });
  if (!initialIntent) {
    throw new AppError('NOT_FOUND', 404, 'BILLING_RECURRING_ADDON_CANCELLATION_TOKEN_INVALID');
  }
  const scope = scopeForSubscription(initialIntent.subscription);
  const subjectFingerprint = recurringAddonSubjectFingerprint({
    appKeyId: params.credential.id,
    serviceId: params.credential.service.id,
    offerId: initialIntent.subscription.offerId,
    subject: params.request,
    scope,
  });
  assertIntentBinding(initialIntent, {
    request: params.request,
    credential: params.credential,
    subjectFingerprint,
  });
  assertCanManageRecurringAddonScope(viewer, initialIntent.subscription.scope);
  const requestDigest = confirmationRequestDigest(params.request);
  await (deps?.authorizeAction ?? authorizeBillingCustomerAction)(
    {
      credential: params.credential,
      organisationId: params.request.organisationId,
      teamId: params.request.teamId,
      userId: params.request.userId,
      authorityScope: scope.customerScope,
      operation: BILLING_CUSTOMER_ACTION.RECURRING_ADDON_CANCEL,
      actorJti: actor.jti,
      request: {
        product: params.request.product,
        organisation_id: params.request.organisationId,
        team_id: params.request.teamId,
        user_id: params.request.userId,
        subscription_id: initialIntent.subscription.id,
        preview_token_digest: tokenDigest,
        idempotency_key_digest: recurringAddonCancellationDigest(params.request.idempotencyKey),
        choice: params.request.choice,
      },
    },
    { prisma },
  );
  const claimed = await claimCancellation(
    {
      tokenDigest,
      requestDigest,
      request: params.request,
      credential: params.credential,
      subjectFingerprint,
      now: deps?.now?.() ?? new Date(),
    },
    prisma,
  );
  if (claimed.kind === 'completed') return claimed.result;
  if (claimed.kind === 'expired') {
    throw new AppError('BAD_REQUEST', 410, 'BILLING_RECURRING_ADDON_CANCELLATION_EXPIRED');
  }

  const current = await prisma.billingRecurringAddonSubscription.findFirst({
    where: {
      id: claimed.subscription.id,
      serviceId: params.credential.service.id,
      orgId: params.request.organisationId,
      OR: [{ scope: 'ORGANISATION', teamId: null }, { teamId: params.request.teamId }],
    },
    include: recurringAddonSubscriptionInclude,
  });
  if (!current) {
    throw new AppError('NOT_FOUND', 404, 'BILLING_RECURRING_ADDON_SUBSCRIPTION_NOT_FOUND');
  }
  assertCurrentSubscriptionPolicy(current);
  if (
    current.id !== claimed.subscription.id ||
    current.updatedAt > claimed.subscription.updatedAt
  ) {
    // The remote refresh below is authoritative; this guard only rejects a local identity replacement.
    if (
      current.accountId !== claimed.subscription.accountId ||
      current.stripeSubscriptionId !== claimed.subscription.stripeSubscriptionId
    ) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_RECURRING_ADDON_CANCELLATION_CHANGED');
    }
  }
  const configured = deps?.stripe ? undefined : requireStripeBillingEnabled();
  const stripe = deps?.stripe ?? configured?.client;
  if (!stripe) throw new AppError('INTERNAL', 503, 'STRIPE_BILLING_DISABLED');
  const account = await resolveStripeAccountContext(
    stripe,
    deps?.stripeLivemode ?? configured?.livemode ?? false,
    prisma,
  );
  if (current.accountId !== account.id) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_ACCOUNT_DRIFT');
  }
  let refreshed = await refreshRecurringAddonSubscriptionProjection(
    { local: current, account, now: deps?.now?.() },
    { prisma, stripe },
  );
  const alreadyScheduled =
    !refreshed.remote ||
    refreshed.local.cancelAtPeriodEnd ||
    ['canceled', 'incomplete_expired'].includes(refreshed.local.status);
  if (refreshed.remote && !alreadyScheduled) {
    const remote = await stripe.subscriptions.update(
      refreshed.remote.id,
      { cancel_at_period_end: true },
      { idempotencyKey: `uoa:recurring-addon-cancel:${claimed.intentId}` },
    );
    refreshed = {
      remote,
      local: await syncRecurringAddonSubscriptionProjection(
        { local: refreshed.local, remote, account, now: deps?.now?.() },
        { prisma },
      ),
    };
  }
  if (
    !refreshed.local.cancelAtPeriodEnd &&
    !['canceled', 'incomplete_expired'].includes(refreshed.local.status)
  ) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_CANCELLATION_DRIFT');
  }
  const result = resultFor(refreshed.local, alreadyScheduled);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.billingRecurringAddonCancellationIntent.updateMany({
      where: {
        id: claimed.intentId,
        state: BillingRecurringAddonCancellationIntentState.PROCESSING,
        confirmationRequestDigest: requestDigest,
      },
      data: {
        state: BillingRecurringAddonCancellationIntentState.COMPLETED,
        result: result as unknown as Prisma.InputJsonValue,
        consumedAt: deps?.now?.() ?? new Date(),
      },
    });
    if (updated.count !== 1) {
      const replay = await tx.billingRecurringAddonCancellationIntent.findUnique({
        where: { id: claimed.intentId },
      });
      if (
        replay?.state === BillingRecurringAddonCancellationIntentState.COMPLETED &&
        replay.confirmationRequestDigest === requestDigest &&
        replay.result
      ) {
        return parseResult(replay.result);
      }
      throw new AppError('BAD_REQUEST', 409, 'BILLING_RECURRING_ADDON_CANCELLATION_CHANGED');
    }
    await tx.orgAuditLog.create({
      data: {
        orgId: params.request.organisationId,
        actorUserId: params.request.userId,
        action: 'billing.recurring_addon_cancellation_confirmed',
        targetType: 'billing_recurring_addon_cancellation_intent',
        targetId: claimed.intentId,
        metadata: {
          service_id: params.credential.service.id,
          subscription_id: refreshed.local.id,
          scope: refreshed.local.scope.toLowerCase(),
        },
      },
    });
    return result;
  });
}
