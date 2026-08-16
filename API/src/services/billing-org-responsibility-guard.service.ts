import {
  BillingAssignmentScope,
  BillingCreditAutoTopUpAttemptStatus,
  BillingCreditCheckoutStatus,
  BillingRecurringAddonCancellationIntentState,
  BillingRecurringAddonCheckoutStatus,
  type Prisma,
} from '@prisma/client';

import { AppError } from '../utils/errors.js';

/**
 * Turning the organisation override on is a stated migration, not a silent
 * switch (Docs/plans/2026-08-15-org-billing-override.md §5).
 *
 * At the moment of enabling, teams may hold live Stripe subscriptions,
 * in-flight checkouts and unresolved auto-top-up attempts. Every one of those
 * is a payment already in motion against a team's own account; moving where
 * the money comes from underneath it would re-bill or strand a customer.
 * So enabling refuses, names what is in flight, and asks for it to settle.
 */
const OPEN_CHECKOUT = { in: ['creating', 'open'] };
const LIVE_SUBSCRIPTION = { notIn: ['canceled', 'incomplete_expired'] };
const UNSETTLED_CREDIT_CHECKOUT = {
  in: [
    BillingCreditCheckoutStatus.CREATING,
    BillingCreditCheckoutStatus.OPEN,
    BillingCreditCheckoutStatus.NEEDS_REVIEW,
  ],
};
const UNRESOLVED_ATTEMPT = {
  in: [
    BillingCreditAutoTopUpAttemptStatus.PENDING,
    BillingCreditAutoTopUpAttemptStatus.PROCESSING,
    BillingCreditAutoTopUpAttemptStatus.REQUIRES_ACTION,
    BillingCreditAutoTopUpAttemptStatus.NEEDS_REVIEW,
  ],
};

export type BillingOrgFundingBlocker = {
  kind:
    | 'stripe_checkout'
    | 'credit_top_up_checkout'
    | 'credit_setup_checkout'
    | 'auto_top_up_attempt'
    | 'recurring_addon_checkout'
    | 'subscription_cancellation_intent'
    | 'recurring_addon_cancellation_intent';
  id: string;
};

export type BillingOrgSubscriptionBlocker = {
  subscriptionId: string;
  serviceId: string;
  scopeKey: string;
  status: string;
};

type GuardClient = Pick<
  Prisma.TransactionClient,
  | 'billingStripeCheckoutSession'
  | 'billingStripeSubscription'
  | 'billingCreditTopUpCheckout'
  | 'billingCreditSetupCheckout'
  | 'billingCreditAutoTopUpAttempt'
  | 'billingRecurringAddonCheckout'
  | 'billingCancellationIntent'
  | 'billingRecurringAddonCancellationIntent'
>;

export async function listOrgFundingActionsInFlight(
  params: { organisationId: string; now: Date },
  deps: { prisma: GuardClient },
): Promise<BillingOrgFundingBlocker[]> {
  const creditAccountScope = { creditAccount: { orgId: params.organisationId } };
  const [
    stripeCheckouts,
    topUpCheckouts,
    setupCheckouts,
    attempts,
    addonCheckouts,
    cancellationIntents,
    addonCancellationIntents,
  ] = await Promise.all([
    deps.prisma.billingStripeCheckoutSession.findMany({
      where: { orgId: params.organisationId, status: OPEN_CHECKOUT },
      select: { id: true },
    }),
    deps.prisma.billingCreditTopUpCheckout.findMany({
      where: { ...creditAccountScope, status: UNSETTLED_CREDIT_CHECKOUT },
      select: { id: true },
    }),
    deps.prisma.billingCreditSetupCheckout.findMany({
      where: { ...creditAccountScope, status: UNSETTLED_CREDIT_CHECKOUT },
      select: { id: true },
    }),
    deps.prisma.billingCreditAutoTopUpAttempt.findMany({
      where: { ...creditAccountScope, status: UNRESOLVED_ATTEMPT },
      select: { id: true },
    }),
    deps.prisma.billingRecurringAddonCheckout.findMany({
      where: {
        orgId: params.organisationId,
        status: {
          in: [
            BillingRecurringAddonCheckoutStatus.CREATING,
            BillingRecurringAddonCheckoutStatus.OPEN,
            BillingRecurringAddonCheckoutStatus.NEEDS_REVIEW,
          ],
        },
      },
      select: { id: true },
    }),
    // A cancellation preview a customer is still looking at is an intent in
    // flight: it can be confirmed a second later against the team's account.
    deps.prisma.billingCancellationIntent.findMany({
      where: {
        orgId: params.organisationId,
        consumedAt: null,
        OR: [{ state: 'PROCESSING' }, { state: 'AVAILABLE', expiresAt: { gt: params.now } }],
      },
      select: { id: true },
    }),
    deps.prisma.billingRecurringAddonCancellationIntent.findMany({
      where: {
        orgId: params.organisationId,
        consumedAt: null,
        OR: [
          { state: BillingRecurringAddonCancellationIntentState.PROCESSING },
          {
            state: BillingRecurringAddonCancellationIntentState.AVAILABLE,
            expiresAt: { gt: params.now },
          },
        ],
      },
      select: { id: true },
    }),
  ]);

  return [
    ...stripeCheckouts.map((row) => ({ kind: 'stripe_checkout' as const, id: row.id })),
    ...topUpCheckouts.map((row) => ({ kind: 'credit_top_up_checkout' as const, id: row.id })),
    ...setupCheckouts.map((row) => ({ kind: 'credit_setup_checkout' as const, id: row.id })),
    ...attempts.map((row) => ({ kind: 'auto_top_up_attempt' as const, id: row.id })),
    ...addonCheckouts.map((row) => ({ kind: 'recurring_addon_checkout' as const, id: row.id })),
    ...cancellationIntents.map((row) => ({
      kind: 'subscription_cancellation_intent' as const,
      id: row.id,
    })),
    ...addonCancellationIntents.map((row) => ({
      kind: 'recurring_addon_cancellation_intent' as const,
      id: row.id,
    })),
  ];
}

export async function listLiveTeamSubscriptions(
  params: { organisationId: string },
  deps: { prisma: GuardClient },
): Promise<BillingOrgSubscriptionBlocker[]> {
  const subscriptions = await deps.prisma.billingStripeSubscription.findMany({
    where: {
      orgId: params.organisationId,
      scope: BillingAssignmentScope.TEAM,
      status: LIVE_SUBSCRIPTION,
    },
    select: { id: true, serviceId: true, scopeKey: true, status: true },
    orderBy: { createdAt: 'asc' },
  });
  return subscriptions.map((row) => ({
    subscriptionId: row.id,
    serviceId: row.serviceId,
    scopeKey: row.scopeKey,
    status: row.status,
  }));
}

export class BillingOrgResponsibilityBlockedError extends AppError {
  public readonly reason: 'FUNDING_ACTION_IN_FLIGHT' | 'TEAM_SUBSCRIPTIONS_ACTIVE';
  public readonly blockers: BillingOrgFundingBlocker[];
  public readonly subscriptions: BillingOrgSubscriptionBlocker[];

  public constructor(params: {
    reason: 'FUNDING_ACTION_IN_FLIGHT' | 'TEAM_SUBSCRIPTIONS_ACTIVE';
    blockers?: BillingOrgFundingBlocker[];
    subscriptions?: BillingOrgSubscriptionBlocker[];
  }) {
    super('BAD_REQUEST', 409, params.reason);
    this.reason = params.reason;
    this.blockers = params.blockers ?? [];
    this.subscriptions = params.subscriptions ?? [];
  }
}

/**
 * Refuse, rather than partially apply. Both probes run before anything is
 * written, inside the caller's transaction, so an organisation either takes
 * billing over completely or not at all.
 *
 * Live team subscriptions are the one case with no safe automatic answer.
 * Auto-migrating them to the organisation scope was considered and rejected:
 * it re-bills a customer without a decision. An operator moves or ends them.
 */
export async function assertOrgBillingAssumable(
  params: { organisationId: string; now: Date },
  deps: { prisma: GuardClient },
): Promise<void> {
  const [blockers, subscriptions] = await Promise.all([
    listOrgFundingActionsInFlight(params, deps),
    listLiveTeamSubscriptions(params, deps),
  ]);
  if (blockers.length > 0) {
    throw new BillingOrgResponsibilityBlockedError({
      reason: 'FUNDING_ACTION_IN_FLIGHT',
      blockers,
    });
  }
  if (subscriptions.length > 0) {
    throw new BillingOrgResponsibilityBlockedError({
      reason: 'TEAM_SUBSCRIPTIONS_ACTIVE',
      subscriptions,
    });
  }
}
