import type { BillingOrganisationFinancialDto as FinancialDto } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { loadAddonData } from './billing-recurring-addon-data.service.js';
import { freezeDisplayedBillingActions } from './billing-action-context.service.js';
import { billingModeRefreshCopy } from './billing-mode-copy.catalog.js';
import { organisationAddonCopy } from './billing-organisation-addon-copy.catalog.js';
import {
  BillingRecurringAddonEntitlementScope,
  BillingRecurringAddonSubscriptionScope,
  type PrismaClient,
} from '@prisma/client';

import type {
  BillingRecurringAddonCancelAction as PublicBillingRecurringAddonCancelAction,
  BillingRecurringAddonCheckoutAction as PublicBillingRecurringAddonCheckoutAction,
  BillingRecurringAddonManagerSubscription,
  BillingRecurringAddonMemberSubscription,
  BillingRecurringAddonsManagerV1 as PublicBillingRecurringAddonsManagerV1,
  BillingRecurringAddonsMemberV1 as PublicBillingRecurringAddonsMemberV1,
  BillingRecurringAddonsV1 as PublicBillingRecurringAddonsV1,
} from '../contracts/billing-statement-v1.js';
import {
  BILLING_RECURRING_ADDONS_CANCELLATION_PREVIEW_PATH,
  BILLING_RECURRING_ADDONS_CHECKOUT_PATH,
} from '../contracts/billing-statement-v1.js';

import type { BillingActorEndpoint } from './billing-actor-audience.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { resolveCreditCollectionContext } from './billing-credit-account.service.js';
import { billingRecurringAddonMoney } from './billing-credit-display.service.js';
import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { billingAddonCopy, billingAddonSubscriptionStatus } from './billing-addon-copy.catalog.js';
import { resolveFinancialTariffContext } from './billing-entitlement.service.js';
import {
  resolveBillingFundingViewer,
  type OrganisationBillingFundingViewer,
} from './billing-funding-viewer.service.js';
import { recurringAddonOfferAvailability } from './billing-recurring-addon-catalog.service.js';
import {
  canManageRecurringAddonScope,
  recurringAddonScope,
  type RecurringAddonSubject,
} from './billing-recurring-addon-scope.service.js';

type Subscription = Awaited<ReturnType<typeof loadAddonData>>['subscriptions'][number];

function statusDisplay(status: string, cancelAtPeriodEnd: boolean, locale?: BillingCustomerLocale): string {
  return cancelAtPeriodEnd ? billingAddonCopy(locale).cancelsAtPeriodEnd : billingAddonSubscriptionStatus(status, locale);
}

function publicScope(scope: BillingRecurringAddonSubscriptionScope) {
  if (scope === BillingRecurringAddonSubscriptionScope.ORGANISATION) return 'organisation' as const;
  if (scope === BillingRecurringAddonSubscriptionScope.TEAM) return 'team' as const;
  return 'subscribing_user' as const;
}

function baseSubscription(subscription: Subscription, locale?: BillingCustomerLocale) {
  return {
    status: subscription.status,
    display_status: statusDisplay(subscription.status, subscription.cancelAtPeriodEnd, locale),
    scope: publicScope(subscription.scope),
    cancel_at_period_end: subscription.cancelAtPeriodEnd,
    current_period_start: subscription.currentPeriodStart?.toISOString() ?? null,
    current_period_end: subscription.currentPeriodEnd?.toISOString() ?? null,
  };
}

function managerSubscription(
  subscription: Subscription | null,
  locale?: BillingCustomerLocale,
): BillingRecurringAddonManagerSubscription | null {
  return subscription
    ? {
        ...baseSubscription(subscription, locale),
        id: subscription.id,
        owner_user_id: subscription.subscribingUserId,
      }
    : null;
}

function memberSubscription(
  subscription: Subscription | null,
  viewerId: string,
  locale?: BillingCustomerLocale,
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
  return { ...baseSubscription(subscription, locale), owner_relationship: ownerRelationship };
}

function entitlement(subscription: Subscription | null, hasPolicy: boolean, locale?: BillingCustomerLocale) {
  const copy = billingAddonCopy(locale);
  if (
    subscription?.entitlementActivatedAt &&
    !subscription.entitlementDeactivatedAt &&
    !['canceled', 'incomplete_expired'].includes(subscription.status)
  ) {
    return {
      state: 'active' as const,
      display_status: copy.entitlementActive,
      description: copy.entitlementActiveDescription,
    };
  }
  if (subscription && !['canceled', 'incomplete_expired'].includes(subscription.status)) {
    return {
      state: 'pending' as const,
      display_status: copy.entitlementPending,
      description: copy.entitlementPendingDescription,
    };
  }
  if (!hasPolicy) {
    return {
      state: 'unavailable' as const,
      display_status: copy.entitlementUnavailable,
      description: copy.entitlementUnavailableDescription,
    };
  }
  return {
    state: 'inactive' as const,
    display_status: copy.entitlementInactive,
    description: copy.entitlementInactiveDescription,
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

type OfferContext = RecurringAddonSubject & { collectionEnabled: boolean; locale?: BillingCustomerLocale };

function managerActions(params: {
  offer: Awaited<ReturnType<typeof loadAddonData>>['offers'][number];
  subscription: Subscription | null;
  data: Awaited<ReturnType<typeof loadAddonData>>;
  viewer: OrganisationBillingFundingViewer;
  context: OfferContext;
  availability: ReturnType<typeof recurringAddonOfferAvailability>;
}): Array<BillingRecurringAddonCheckoutAction | BillingRecurringAddonCancelAction> {
  const copy = billingAddonCopy(params.context.locale);
  if (!params.availability.entitlementScope) return [];
  if(params.context.teamId===null&&params.availability.entitlementScope!==BillingRecurringAddonEntitlementScope.ORGANISATION)return [];
  const scope = recurringAddonScope(params.availability.entitlementScope, {
    product: params.context.product,
    organisationId: params.context.organisationId,
    teamId: params.context.teamId,
    userId: params.context.userId,
  });
  if (!canManageRecurringAddonScope(params.viewer, scope.scope)) return [];
  if (params.subscription) {
    const enabled =
      params.context.collectionEnabled &&
      !params.subscription.cancelAtPeriodEnd &&
      !['canceled', 'incomplete_expired'].includes(params.subscription.status);
    return [
      {
        id: 'cancel',
        kind: 'confirmation_dialog',
        label: copy.cancelAction,
        description: copy.cancelActionDescription,
        enabled,
        disabled_reason: enabled
          ? null
          : !params.context.collectionEnabled
            ? copy.noCollection
            : copy.cancellationAlreadyScheduled,
        request: {
          method: 'POST',
          path: BILLING_RECURRING_ADDONS_CANCELLATION_PREVIEW_PATH,
          body: {
            product: params.context.product,
            organisation_id: params.context.organisationId,
            team_id: params.context.teamId,
            user_id: params.context.userId,
            subscription_id: params.subscription.id,
          },
        },
      },
    ];
  }
  const pending = params.data.retainedSubscriptions.some(row=>row.offerKey===params.offer.key)||params.data.checkouts.some(
    (checkout) =>
      checkout.offerId === params.offer.id &&
      checkout.scope === scope.scope &&
      checkout.scopeKey === scope.scopeKey,
  );
  const enabled = params.availability.available && !pending;
  return [
    {
      id: 'subscribe',
      kind: 'hosted_redirect',
      label: copy.subscribeAction,
      description: copy.subscribeActionDescription,
      enabled,
      disabled_reason: enabled
        ? null
        : pending
          ? copy.checkoutAlreadyOpen
          : params.availability.entitlementScope ? copy.checkoutUnavailable : copy.noEntitlementScope,
      request: {
        method: 'POST',
        path: BILLING_RECURRING_ADDONS_CHECKOUT_PATH,
        body: {
          product: params.context.product,
          organisation_id: params.context.organisationId,
          team_id: params.context.teamId,
          user_id: params.context.userId,
          offer_id: params.offer.id,
        },
      },
    },
  ];
}

function offersForManager(
  data: Awaited<ReturnType<typeof loadAddonData>>,
  viewer: OrganisationBillingFundingViewer,
  context: OfferContext,
): BillingRecurringAddonsManagerV1['offers'] {
  const copy = billingAddonCopy(context.locale);
  return data.offers.map((offer) => {
    const scopes = new Set(offer.featurePolicies.map((policy) => policy.entitlementScope));
    const subscription = selectSubscription(
      data.subscriptions.filter((row) => row.offerId === offer.id&&
        (row.scope===BillingRecurringAddonSubscriptionScope.ORGANISATION||row.teamId===context.teamId)),
      scopes,
      viewer.userId,
    );
    const sourceAvailability = recurringAddonOfferAvailability(offer, context.collectionEnabled);
    const retained=data.retainedSubscriptions.some(row=>row.offerKey===offer.key);
    const availability={...sourceAvailability,available:sourceAvailability.available&&!retained&&
      (context.teamId!==null||sourceAvailability.entitlementScope===BillingRecurringAddonEntitlementScope.ORGANISATION)};
    return {
      id: offer.id,
      key: offer.key,
      version: offer.version,
      name: context.product === 'deepwater' && offer.key === 'privacy' && offer.version === 1 ? copy.privacyOfferName : offer.name,
      description: context.product === 'deepwater' && offer.key === 'privacy' && offer.version === 1 ? copy.privacyOfferDescription : offer.description,
      benefits: context.product === 'deepwater' && offer.key === 'privacy' && offer.version === 1 ? [copy.privacyBenefit] : offer.benefits,
      monthly_price: billingRecurringAddonMoney(
        offer.monthlyAmountMinor,
        offer.currency,
        context.locale,
      ),
      interval: 'month',
      available: availability.available,
      unavailable_reason: availability.available ? null : retained?organisationAddonCopy(context.locale).retained:
        context.teamId===null&&availability.entitlementScope!==BillingRecurringAddonEntitlementScope.ORGANISATION?
          organisationAddonCopy(context.locale).targetRequired:!context.collectionEnabled ? copy.noCollection : availability.entitlementScope ? copy.checkoutUnavailable : copy.noEntitlementScope,
      entitlement: entitlement(subscription, offer.featurePolicies.length > 0, context.locale),
      subscription: managerSubscription(subscription, context.locale),
      actions: managerActions({ offer, subscription, data, viewer, context, availability }),
    };
  });
}

function offersForMember(
  data: Awaited<ReturnType<typeof loadAddonData>>,
  viewer: OrganisationBillingFundingViewer,
  context: OfferContext,
): BillingRecurringAddonsMemberV1['offers'] {
  const copy = billingAddonCopy(context.locale);
  return data.offers.map((offer) => {
    const scopes = new Set(offer.featurePolicies.map((policy) => policy.entitlementScope));
    const subscription = selectSubscription(
      data.subscriptions.filter((row) => row.offerId === offer.id),
      scopes,
      viewer.userId,
    );
    const availability = recurringAddonOfferAvailability(offer, context.collectionEnabled);
    return {
      id: offer.id,
      key: offer.key,
      version: offer.version,
      name: context.product === 'deepwater' && offer.key === 'privacy' && offer.version === 1 ? copy.privacyOfferName : offer.name,
      description: context.product === 'deepwater' && offer.key === 'privacy' && offer.version === 1 ? copy.privacyOfferDescription : offer.description,
      benefits: context.product === 'deepwater' && offer.key === 'privacy' && offer.version === 1 ? [copy.privacyBenefit] : offer.benefits,
      monthly_price: billingRecurringAddonMoney(
        offer.monthlyAmountMinor,
        offer.currency,
        context.locale,
      ),
      interval: 'month',
      available: availability.available,
      unavailable_reason: availability.available ? null : !context.collectionEnabled ? copy.noCollection : availability.entitlementScope ? copy.checkoutUnavailable : copy.noEntitlementScope,
      entitlement: entitlement(subscription, offer.featurePolicies.length > 0, context.locale),
      subscription: memberSubscription(subscription, viewer.userId, context.locale),
      actions: [],
    };
  });
}

export async function getBillingRecurringAddons(
  params: {
    request: {
      product: string;
      organisationId: string;
      teamId: string|null;
      userId: string;
    };
    actorToken: string;
    credential: VerifiedBillingAppKey;
    endpoint: BillingActorEndpoint;
    locale?: BillingCustomerLocale;
    supportsBillingMode?: boolean;
  },
  deps?: {
    prisma?: PrismaClient;
    now?: () => Date;
    resolveEntitlement?: typeof resolveFinancialTariffContext;
    resolveCollection?: typeof resolveCreditCollectionContext;
    resolveViewer?: typeof resolveBillingFundingViewer;
    loadData?: typeof loadAddonData;
  },
): Promise<BillingRecurringAddonsV1> {
  const prisma = deps?.prisma;
  await (deps?.resolveEntitlement ?? resolveFinancialTariffContext)(
    {
      request: params.request,
      actorToken: params.actorToken,
      credential: params.credential,
      endpoint: params.endpoint,
    },
    { prisma },
  );
  const viewer=await (deps?.resolveViewer ?? resolveBillingFundingViewer)(params.request,{prisma});
  if (!viewer.billingManager) throw new AppError('FORBIDDEN',403,'BILLING_MANAGER_REQUIRED');
  const collection=await (deps?.resolveCollection ?? resolveCreditCollectionContext)(
      {
        organisationId: params.request.organisationId,
        teamId: params.request.teamId,
      },
      { prisma },
    );
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
    title: `${params.credential.service.name} ${billingAddonCopy(params.locale).titleSuffix}`,
    description: `${billingAddonCopy(params.locale).catalogDescription} ${organisationAddonCopy(params.locale).description}${
      params.request.teamId===null?` ${organisationAddonCopy(params.locale).targetRequired}`:''}`,
  };
  const offerContext: OfferContext = {
    product: params.credential.service.identifier,
    organisationId: params.request.organisationId,
    teamId: params.request.teamId,
    userId: params.request.userId,
    collectionEnabled: collection.stripeCollectionEnabled,
    locale: params.locale,
  };
  if (viewer.billingManager) {
    const offers = offersForManager(data, viewer, offerContext);
    return freezeDisplayedBillingActions({
      ...common,
      viewer: {
        role: 'billing_manager',
        entitlement_visibility: 'full_team',
        description: billingAddonCopy(params.locale).managerViewerDescription,
      },
      capabilities: {
        can_manage_addons: offers.some((offer) => offer.actions.some((action) => action.enabled)),
      },
      offers,
    } as BillingRecurringAddonsV1, { account: collection.account, revision: collection.modeRevision ?? 0, scopeEpoch: collection.scopeEpoch,
      appKeyId: params.credential.id }, params.supportsBillingMode === true, billingModeRefreshCopy(params.locale), now);
  }
  return {
    ...common,
    viewer: {
      role: 'member',
      entitlement_visibility: 'own_plus_team_status',
      description: billingAddonCopy(params.locale).memberViewerDescription,
    },
    capabilities: { can_manage_addons: false },
    offers: offersForMember(data, viewer, offerContext),
  };
}

type BillingRecurringAddonsV1=FinancialDto<PublicBillingRecurringAddonsV1>;

type BillingRecurringAddonsManagerV1=FinancialDto<PublicBillingRecurringAddonsManagerV1>;

type BillingRecurringAddonsMemberV1=FinancialDto<PublicBillingRecurringAddonsMemberV1>;

type BillingRecurringAddonCheckoutAction=FinancialDto<PublicBillingRecurringAddonCheckoutAction>;

type BillingRecurringAddonCancelAction=FinancialDto<PublicBillingRecurringAddonCancelAction>;
