import {
  BillingAssignmentScope,
  MembershipStatus,
  type BillingStripeSubscription,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import type Stripe from 'stripe';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  resolveEffectiveTariffContext,
  type EffectiveTariffPayload,
} from './billing-entitlement.service.js';
import {
  assertStripeObjectLivemode,
  requireStripeBillingEnabled,
  resolveStripeAccountContext,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import { billingScope } from './billing-stripe-checkout-state.service.js';
import { isBillingManager } from './billing-stripe-manager.service.js';
import { stripeBillingPeriodPhase } from './billing-stripe-period.service.js';
import { normalizeStripeReturnUrl } from './billing-stripe-return-url.service.js';
import { refreshStripeSubscriptionProjection } from './billing-stripe-webhook.service.js';

export type BillingSubscriptionRequest = {
  product: string;
  organisationId: string;
  teamId: string;
  userId: string;
};

type StripeSubscriptionClient = Pick<Stripe, 'accounts' | 'billingPortal' | 'subscriptions'>;

type Dependencies = {
  prisma?: PrismaClient;
  stripe?: StripeSubscriptionClient;
  stripeLivemode?: boolean;
  resolveTariff?: typeof resolveEffectiveTariffContext;
  refreshSubscription?: typeof refreshStripeSubscriptionProjection;
};

type SubscriptionWithCustomer = BillingStripeSubscription & {
  customer: {
    stripeCustomerId: string | null;
  };
  account: {
    stripeAccountId: string;
    livemode: boolean;
  };
};

type LifecycleContext = {
  prisma: PrismaClient;
  stripe: StripeSubscriptionClient | null;
  account: StripeAccountContext | null;
  stripeCollectionEnabled: boolean;
  payload: EffectiveTariffPayload;
  subscription: SubscriptionWithCustomer | null;
  canManage: boolean;
};

function activeSubscriptionWhere(
  account: StripeAccountContext | null,
  serviceId: string,
  payload: EffectiveTariffPayload,
): Prisma.BillingStripeSubscriptionWhereInput {
  const scope = billingScope(payload);
  return {
    ...(account ? { accountId: account.id } : {}),
    serviceId,
    orgId: payload.subject.organisation_id,
    status: { notIn: ['canceled', 'incomplete_expired'] },
    OR:
      scope.scope === BillingAssignmentScope.ORGANISATION
        ? [{ scope: BillingAssignmentScope.ORGANISATION, scopeKey: scope.scopeKey }]
        : [
            {
              scope: BillingAssignmentScope.ORGANISATION,
              scopeKey: payload.subject.organisation_id,
            },
            { scope: BillingAssignmentScope.TEAM, scopeKey: scope.scopeKey },
          ],
  };
}

async function currentSubscription(
  prisma: PrismaClient,
  account: StripeAccountContext,
  serviceId: string,
  payload: EffectiveTariffPayload,
): Promise<SubscriptionWithCustomer | null> {
  return prisma.billingStripeSubscription.findFirst({
    where: activeSubscriptionWhere(account, serviceId, payload),
    include: {
      customer: {
        select: { stripeCustomerId: true },
      },
      account: {
        select: { stripeAccountId: true, livemode: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function lifecycleContext(
  params: {
    request: BillingSubscriptionRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: Dependencies,
  options: { requireStripe: boolean } = { requireStripe: true },
): Promise<LifecycleContext> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const { payload } = await (deps?.resolveTariff ?? resolveEffectiveTariffContext)(params, {
    prisma,
  });
  const [orgMember, teamMember] = await Promise.all([
    prisma.orgMember.findUnique({
      where: {
        orgId_userId: {
          orgId: payload.subject.organisation_id,
          userId: payload.subject.user_id,
        },
      },
      select: { role: true, status: true },
    }),
    prisma.teamMember.findUnique({
      where: {
        teamId_userId: {
          teamId: payload.subject.team_id,
          userId: payload.subject.user_id,
        },
      },
      select: { teamRole: true, status: true },
    }),
  ]);
  if (
    orgMember?.status !== MembershipStatus.ACTIVE ||
    teamMember?.status !== MembershipStatus.ACTIVE
  ) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_SUBJECT_NOT_ENTITLED');
  }

  const billingEnabled = Boolean(deps?.stripe) || getEnv().STRIPE_BILLING_ENABLED;
  if (!billingEnabled) {
    if (options.requireStripe) {
      throw new AppError('INTERNAL', 503, 'STRIPE_BILLING_DISABLED');
    }
    const known = await prisma.billingStripeSubscription.findMany({
      where: activeSubscriptionWhere(null, params.credential.service.id, payload),
      include: {
        customer: { select: { stripeCustomerId: true } },
        account: { select: { stripeAccountId: true, livemode: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 2,
    });
    if (known.length > 1) {
      throw new AppError('BAD_REQUEST', 409, 'STRIPE_SUBSCRIPTION_ACCOUNT_AMBIGUOUS');
    }
    const subscription = known[0] ?? null;
    const selectedScope = subscription?.scope ?? billingScope(payload).scope;
    return {
      prisma,
      stripe: null,
      account: null,
      stripeCollectionEnabled: false,
      payload,
      subscription,
      canManage: isBillingManager({
        scope: selectedScope,
        orgRole: orgMember.role,
        teamRole: teamMember.teamRole,
      }),
    };
  }

  const configured = deps?.stripe ? undefined : requireStripeBillingEnabled();
  const stripe = deps?.stripe ?? configured?.client;
  if (!stripe) throw new AppError('INTERNAL', 503, 'STRIPE_BILLING_DISABLED');
  const livemode = deps?.stripeLivemode ?? configured?.livemode ?? false;
  const account = await resolveStripeAccountContext(stripe, livemode, prisma);
  let subscription = await currentSubscription(
    prisma,
    account,
    params.credential.service.id,
    payload,
  );
  if (subscription) {
    await (deps?.refreshSubscription ?? refreshStripeSubscriptionProjection)(
      {
        subscriptionId: subscription.stripeSubscriptionId,
        account,
      },
      { prisma, stripe },
    );
    subscription = await currentSubscription(
      prisma,
      account,
      params.credential.service.id,
      payload,
    );
  }
  const selectedScope = subscription?.scope ?? billingScope(payload).scope;
  return {
    prisma,
    stripe,
    account,
    stripeCollectionEnabled: true,
    payload,
    subscription,
    canManage: isBillingManager({
      scope: selectedScope,
      orgRole: orgMember.role,
      teamRole: teamMember.teamRole,
    }),
  };
}

function serializeSubscription(context: LifecycleContext) {
  const subscription = context.subscription;
  return {
    product: context.payload.product,
    subject: context.payload.subject,
    tariff: context.payload.tariff,
    assignment: context.payload.assignment,
    stripe_collection_enabled: context.stripeCollectionEnabled,
    stripe_mode: context.account
      ? context.account.livemode
        ? ('live' as const)
        : ('test' as const)
      : subscription
        ? subscription.livemode
          ? ('live' as const)
          : ('test' as const)
        : null,
    can_manage: context.canManage,
    subscription: subscription
      ? {
          id: subscription.id,
          status: subscription.status,
          scope: subscription.scope.toLowerCase(),
          scope_key: subscription.scopeKey,
          tariff_id: subscription.tariffId,
          cancel_at_period_end: subscription.cancelAtPeriodEnd,
          current_period_start: subscription.currentPeriodStart?.toISOString() ?? null,
          current_period_end: subscription.currentPeriodEnd?.toISOString() ?? null,
          billing_phase: stripeBillingPeriodPhase(
            subscription.currentPeriodStart,
            subscription.currentPeriodEnd,
          ),
          created_at: subscription.createdAt.toISOString(),
          synced_at: subscription.updatedAt.toISOString(),
        }
      : null,
  };
}

function requireManageableSubscription(context: LifecycleContext): {
  subscription: SubscriptionWithCustomer & { customer: { stripeCustomerId: string } };
  stripe: StripeSubscriptionClient;
  account: StripeAccountContext;
} {
  if (!context.stripe || !context.account || !context.stripeCollectionEnabled) {
    throw new AppError('INTERNAL', 503, 'STRIPE_BILLING_DISABLED');
  }
  if (!context.canManage) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_MANAGER_REQUIRED');
  }
  if (!context.subscription) {
    throw new AppError('NOT_FOUND', 404, 'STRIPE_SUBSCRIPTION_NOT_FOUND');
  }
  if (!context.subscription.customer.stripeCustomerId) {
    throw new AppError('INTERNAL', 500, 'STRIPE_CUSTOMER_INCOMPLETE');
  }
  return {
    subscription: context.subscription as SubscriptionWithCustomer & {
      customer: { stripeCustomerId: string };
    },
    stripe: context.stripe,
    account: context.account,
  };
}

export async function getStripeSubscriptionSummary(
  params: {
    request: BillingSubscriptionRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: Dependencies,
) {
  return serializeSubscription(await lifecycleContext(params, deps, { requireStripe: false }));
}

export async function createStripePortalSession(
  params: {
    request: BillingSubscriptionRequest & { returnUrl: string };
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: Dependencies,
): Promise<{ portal_url: string }> {
  const returnUrl = normalizeStripeReturnUrl(
    params.request.returnUrl,
    params.credential.checkoutReturnOrigins,
  );
  const context = await lifecycleContext(params, deps);
  const { account, stripe, subscription } = requireManageableSubscription(context);
  const session = await stripe.billingPortal.sessions.create({
    customer: subscription.customer.stripeCustomerId,
    return_url: returnUrl,
  });
  assertStripeObjectLivemode(session, account.livemode);
  if (!session.url.startsWith('https://')) {
    throw new AppError('INTERNAL', 502, 'STRIPE_PORTAL_URL_INVALID');
  }
  await context.prisma.orgAuditLog.create({
    data: {
      orgId: context.payload.subject.organisation_id,
      actorUserId: context.payload.subject.user_id,
      action: 'billing.stripe_portal_created',
      targetType: 'billing_stripe_subscription',
      targetId: subscription.id,
      metadata: {
        product: params.credential.service.identifier,
        service_id: params.credential.service.id,
        scope: subscription.scope.toLowerCase(),
        scope_key: subscription.scopeKey,
        stripe_account_id: account.stripeAccountId,
        livemode: account.livemode,
      },
    },
  });
  return { portal_url: session.url };
}
