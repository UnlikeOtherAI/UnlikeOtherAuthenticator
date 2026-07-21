import {
  BillingRecurringAddonEntitlementScope,
  BillingRecurringAddonSubscriptionScope,
  type PrismaClient,
} from '@prisma/client';

import type {
  BillingRecurringAddonManagerSubscription,
  BillingRecurringAddonMemberSubscription,
  BillingRecurringAddonsManagerV1,
  BillingRecurringAddonsMemberV1,
  BillingRecurringAddonsV1,
} from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { resolveCreditCollectionContext } from './billing-credit-account.service.js';
import { billingRecurringAddonMoney } from './billing-credit-display.service.js';
import { resolveEffectiveTariffContext } from './billing-entitlement.service.js';
import {
  resolveBillingFundingViewer,
  type BillingFundingViewer,
} from './billing-funding-viewer.service.js';

type Subscription = Awaited<ReturnType<typeof loadAddonData>>['subscriptions'][number];

function statusDisplay(status: string, cancelAtPeriodEnd: boolean): string {
  if (cancelAtPeriodEnd) return 'Cancels at period end';
  return status.replaceAll('_', ' ').replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function publicScope(scope: BillingRecurringAddonSubscriptionScope) {
  if (scope === BillingRecurringAddonSubscriptionScope.ORGANISATION) return 'organisation' as const;
  if (scope === BillingRecurringAddonSubscriptionScope.TEAM) return 'team' as const;
  return 'subscribing_user' as const;
}

function baseSubscription(subscription: Subscription) {
  return {
    status: subscription.status,
    display_status: statusDisplay(subscription.status, subscription.cancelAtPeriodEnd),
    scope: publicScope(subscription.scope),
    cancel_at_period_end: subscription.cancelAtPeriodEnd,
    current_period_start: subscription.currentPeriodStart?.toISOString() ?? null,
    current_period_end: subscription.currentPeriodEnd?.toISOString() ?? null,
  };
}

function managerSubscription(
  subscription: Subscription | null,
): BillingRecurringAddonManagerSubscription | null {
  return subscription
    ? {
        ...baseSubscription(subscription),
        id: subscription.id,
        owner_user_id: subscription.subscribingUserId,
      }
    : null;
}

function memberSubscription(
  subscription: Subscription | null,
  viewerId: string,
): BillingRecurringAddonMemberSubscription | null {
  if (!subscription) return null;
  const ownerRelationship =
    subscription.scope === BillingRecurringAddonSubscriptionScope.ORGANISATION
      ? ('organisation' as const)
      : subscription.scope === BillingRecurringAddonSubscriptionScope.TEAM
        ? ('team' as const)
        : subscription.subscribingUserId === viewerId
          ? ('viewer' as const)
          : ('other_team_member' as const);
  return { ...baseSubscription(subscription), owner_relationship: ownerRelationship };
}

function entitlement(subscription: Subscription | null, hasPolicy: boolean) {
  if (
    subscription?.entitlementActivatedAt &&
    !subscription.entitlementDeactivatedAt &&
    !['canceled', 'incomplete_expired'].includes(subscription.status)
  ) {
    return {
      state: 'active' as const,
      display_status: 'Add-on entitlement is active',
      description: 'UOA has activated this entitlement for its exact subscription scope.',
    };
  }
  if (subscription && !['canceled', 'incomplete_expired'].includes(subscription.status)) {
    return {
      state: 'pending' as const,
      display_status: 'Add-on entitlement is pending',
      description: 'UOA is waiting for verified payment or entitlement activation.',
    };
  }
  if (!hasPolicy) {
    return {
      state: 'unavailable' as const,
      display_status: 'Add-on entitlement is unavailable',
      description: 'No active entitlement policy is configured for this offer.',
    };
  }
  return {
    state: 'inactive' as const,
    display_status: 'Add-on entitlement is inactive',
    description: 'This exact organisation, team, or user scope has no active entitlement.',
  };
}

function scopeRank(
  scope: BillingRecurringAddonSubscriptionScope,
  viewerId: string,
  userId: string | null,
) {
  if (scope === BillingRecurringAddonSubscriptionScope.SUBSCRIBING_USER && userId === viewerId) {
    return 0;
  }
  if (scope === BillingRecurringAddonSubscriptionScope.TEAM) return 1;
  if (scope === BillingRecurringAddonSubscriptionScope.ORGANISATION) return 2;
  return 3;
}

function selectSubscription(
  subscriptions: Subscription[],
  scopes: Set<BillingRecurringAddonEntitlementScope>,
  viewerId: string,
) {
  const allowed = new Set(
    [...scopes].map((scope) =>
      scope === BillingRecurringAddonEntitlementScope.ORGANISATION
        ? BillingRecurringAddonSubscriptionScope.ORGANISATION
        : scope === BillingRecurringAddonEntitlementScope.TEAM
          ? BillingRecurringAddonSubscriptionScope.TEAM
          : BillingRecurringAddonSubscriptionScope.SUBSCRIBING_USER,
    ),
  );
  return (
    subscriptions
      .filter(
        (subscription) =>
          allowed.has(subscription.scope) &&
          !['canceled', 'incomplete_expired'].includes(subscription.status),
      )
      .sort((left, right) => {
        const rank =
          scopeRank(left.scope, viewerId, left.subscribingUserId) -
          scopeRank(right.scope, viewerId, right.subscribingUserId);
        return rank || right.updatedAt.getTime() - left.updatedAt.getTime();
      })[0] ?? null
  );
}

async function loadAddonData(
  params: {
    accountId: string;
    serviceId: string;
    organisationId: string;
    teamId: string;
  },
  deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const [offers, subscriptions] = await Promise.all([
    prisma.billingRecurringAddonOffer.findMany({
      where: { serviceId: params.serviceId, active: true },
      orderBy: [{ key: 'asc' }, { version: 'desc' }],
      include: {
        catalogs: { where: { accountId: params.accountId } },
        featurePolicies: { where: { active: true } },
      },
    }),
    prisma.billingRecurringAddonSubscription.findMany({
      where: {
        accountId: params.accountId,
        serviceId: params.serviceId,
        orgId: params.organisationId,
        OR: [
          {
            scope: BillingRecurringAddonSubscriptionScope.ORGANISATION,
            teamId: null,
            subscribingUserId: null,
          },
          {
            scope: BillingRecurringAddonSubscriptionScope.TEAM,
            teamId: params.teamId,
            subscribingUserId: null,
          },
          {
            scope: BillingRecurringAddonSubscriptionScope.SUBSCRIBING_USER,
            teamId: params.teamId,
            subscribingUserId: { not: null },
          },
        ],
      },
      orderBy: { updatedAt: 'desc' },
    }),
  ]);
  return { offers, subscriptions };
}

function offersForManager(
  data: Awaited<ReturnType<typeof loadAddonData>>,
  viewer: BillingFundingViewer,
): BillingRecurringAddonsManagerV1['offers'] {
  return data.offers.map((offer) => {
    const scopes = new Set(offer.featurePolicies.map((policy) => policy.entitlementScope));
    const subscription = selectSubscription(
      data.subscriptions.filter((row) => row.offerId === offer.id),
      scopes,
      viewer.userId,
    );
    const catalog = offer.catalogs[0];
    const available = Boolean(
      offer.featurePolicies.length &&
      catalog?.stripePriceId &&
      catalog.currency === offer.currency &&
      catalog.monthlyAmountMinor === offer.monthlyAmountMinor,
    );
    return {
      id: offer.id,
      key: offer.key,
      version: offer.version,
      name: offer.name,
      description: offer.description,
      benefits: offer.benefits,
      monthly_price: billingRecurringAddonMoney(offer.monthlyAmountMinor),
      interval: 'month',
      available,
      unavailable_reason: available ? null : 'Checkout is not configured for this offer.',
      entitlement: entitlement(subscription, offer.featurePolicies.length > 0),
      subscription: managerSubscription(subscription),
      actions: [],
    };
  });
}

function offersForMember(
  data: Awaited<ReturnType<typeof loadAddonData>>,
  viewer: BillingFundingViewer,
): BillingRecurringAddonsMemberV1['offers'] {
  return data.offers.map((offer) => {
    const scopes = new Set(offer.featurePolicies.map((policy) => policy.entitlementScope));
    const subscription = selectSubscription(
      data.subscriptions.filter((row) => row.offerId === offer.id),
      scopes,
      viewer.userId,
    );
    const catalog = offer.catalogs[0];
    const available = Boolean(
      offer.featurePolicies.length &&
      catalog?.stripePriceId &&
      catalog.currency === offer.currency &&
      catalog.monthlyAmountMinor === offer.monthlyAmountMinor,
    );
    return {
      id: offer.id,
      key: offer.key,
      version: offer.version,
      name: offer.name,
      description: offer.description,
      benefits: offer.benefits,
      monthly_price: billingRecurringAddonMoney(offer.monthlyAmountMinor),
      interval: 'month',
      available,
      unavailable_reason: available ? null : 'Checkout is not configured for this offer.',
      entitlement: entitlement(subscription, offer.featurePolicies.length > 0),
      subscription: memberSubscription(subscription, viewer.userId),
      actions: [],
    };
  });
}

export async function getBillingRecurringAddons(
  params: {
    request: {
      product: string;
      organisationId: string;
      teamId: string;
      userId: string;
    };
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: {
    prisma?: PrismaClient;
    now?: () => Date;
    resolveEntitlement?: typeof resolveEffectiveTariffContext;
    resolveCollection?: typeof resolveCreditCollectionContext;
    resolveViewer?: typeof resolveBillingFundingViewer;
    loadData?: typeof loadAddonData;
  },
): Promise<BillingRecurringAddonsV1> {
  const prisma = deps?.prisma;
  await (deps?.resolveEntitlement ?? resolveEffectiveTariffContext)(
    {
      request: params.request,
      actorToken: params.actorToken,
      credential: params.credential,
    },
    { prisma },
  );
  const [collection, viewer] = await Promise.all([
    (deps?.resolveCollection ?? resolveCreditCollectionContext)(
      {
        organisationId: params.request.organisationId,
        teamId: params.request.teamId,
      },
      { prisma },
    ),
    (deps?.resolveViewer ?? resolveBillingFundingViewer)(
      {
        userId: params.request.userId,
        organisationId: params.request.organisationId,
        teamId: params.request.teamId,
      },
      { prisma },
    ),
  ]);
  const data = await (deps?.loadData ?? loadAddonData)(
    {
      accountId: collection.account.id,
      serviceId: params.credential.service.id,
      organisationId: params.request.organisationId,
      teamId: params.request.teamId,
    },
    { prisma },
  );
  const now = deps?.now?.() ?? new Date();
  const common = {
    schema_version: 1 as const,
    generated_at: now.toISOString(),
    product: {
      id: params.credential.service.id,
      identifier: params.credential.service.identifier,
      name: params.credential.service.name,
    },
    subject: {
      user_id: params.request.userId,
      organisation_id: params.request.organisationId,
      team_id: params.request.teamId,
    },
    collection: {
      stripe_collection_enabled: collection.stripeCollectionEnabled,
      stripe_mode: collection.account.livemode ? ('live' as const) : ('test' as const),
    },
    title: `${params.credential.service.name} add-ons`,
    description: 'Optional subscriptions are billed separately from metered usage credits.',
  };
  if (viewer.billingManager) {
    return {
      ...common,
      viewer: {
        role: 'billing_manager',
        entitlement_visibility: 'full_team',
        description: 'This viewer may see full entitlement status and manage team add-ons.',
      },
      capabilities: { can_manage_addons: false },
      offers: offersForManager(data, viewer),
    };
  }
  return {
    ...common,
    viewer: {
      role: 'member',
      entitlement_visibility: 'own_plus_team_status',
      description: 'This viewer may see their relationship and privacy-safe team status.',
    },
    capabilities: { can_manage_addons: false },
    offers: offersForMember(data, viewer),
  };
}
