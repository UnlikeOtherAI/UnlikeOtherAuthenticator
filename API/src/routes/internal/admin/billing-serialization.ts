import type { BillingAppKeyRecord } from '../../../services/billing-app-key.service.js';

type Tariff = {
  id: string;
  serviceId: string;
  key: string;
  version: number;
  name: string;
  mode: string;
  collectionMode: string;
  markupBps: number;
  monthlyAmountMinor: bigint;
  currency: string;
  isDefault: boolean;
  createdByEmail: string | null;
  createdAt: Date;
};

export function serializeBillingTariff(tariff: Tariff) {
  return {
    id: tariff.id,
    service_id: tariff.serviceId,
    key: tariff.key,
    version: tariff.version,
    name: tariff.name,
    mode: tariff.mode.toLowerCase(),
    collection_mode: tariff.collectionMode.toLowerCase(),
    markup_bps: tariff.markupBps,
    monthly_subscription: {
      amount_minor: tariff.monthlyAmountMinor.toString(),
      currency: tariff.currency,
    },
    is_default: tariff.isDefault,
    created_by_email: tariff.createdByEmail,
    created_at: tariff.createdAt.toISOString(),
  };
}

export function serializeBillingAppKey(record: BillingAppKeyRecord) {
  return {
    id: record.id,
    service_id: record.serviceId,
    purpose: record.purpose.toLowerCase(),
    name: record.name,
    key_prefix: record.keyPrefix,
    actor_issuer: record.actorIssuer,
    actor_audience: record.actorAudience,
    actor_key_id: record.actorKeyId,
    checkout_return_origins: record.checkoutReturnOrigins,
    last_used_at: record.lastUsedAt?.toISOString() ?? null,
    expires_at: record.expiresAt?.toISOString() ?? null,
    revoked_at: record.revokedAt?.toISOString() ?? null,
    created_by_email: record.createdByEmail,
    created_at: record.createdAt.toISOString(),
  };
}

type ListedService = {
  id: string;
  identifier: string;
  name: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  tariffs: Tariff[];
  assignments: Array<{
    id: string;
    serviceId: string;
    tariffId: string;
    orgId: string;
    teamId: string | null;
    scope: string;
    createdByEmail: string | null;
    createdAt: Date;
    updatedAt: Date;
    tariff: Tariff;
    org: { id: string; name: string };
    team: { id: string; name: string } | null;
  }>;
  appKeys: Array<{
    id: string;
    purpose: string;
    name: string;
    keyPrefix: string;
    actorIssuer: string;
    actorAudience: string;
    actorKeyId: string;
    checkoutReturnOrigins: string[];
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
    createdByEmail: string | null;
    createdAt: Date;
  }>;
  adjustments: Array<{
    id: string;
    serviceId: string;
    orgId: string;
    teamId: string | null;
    scope: string;
    scopeKey: string;
    key: string;
    name: string;
    kind: string;
    cadence: string;
    amountMinor: bigint;
    currency: string;
    startsAt: Date;
    endsAt: Date | null;
    active: boolean;
    createdByEmail: string | null;
    createdAt: Date;
    updatedAt: Date;
    org: { id: string; name: string };
    team: { id: string; name: string } | null;
  }>;
  stripeCatalogs: Array<{
    id: string;
    accountId: string;
    currency: string;
    meterEventName: string;
    stripeProductId: string | null;
    stripeMeterId: string | null;
    stripeUsagePriceId: string | null;
    account: { stripeAccountId: string; livemode: boolean };
    tariffPrices: Array<{
      id: string;
      tariffId: string;
      monthlyAmountMinor: bigint;
      stripeMonthlyPriceId: string | null;
    }>;
  }>;
  stripeSubscriptions: Array<{
    id: string;
    accountId: string;
    checkoutId: string;
    tariffId: string;
    tariffSource: string;
    tariffAssignmentId: string | null;
    scope: string;
    scopeKey: string;
    stripeSubscriptionId: string;
    stripeMonthlyItemId: string | null;
    stripeUsageItemId: string;
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    livemode: boolean;
    account: { stripeAccountId: string; livemode: boolean };
    org: { id: string; name: string };
    team: { id: string; name: string } | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
};

export function serializeBillingService(service: ListedService) {
  return {
    id: service.id,
    identifier: service.identifier,
    name: service.name,
    active: service.active,
    tariffs: service.tariffs.map(serializeBillingTariff),
    assignments: service.assignments.map((assignment) => ({
      id: assignment.id,
      tariff_id: assignment.tariffId,
      scope: assignment.scope.toLowerCase(),
      organisation: assignment.org,
      team: assignment.team,
      tariff: serializeBillingTariff(assignment.tariff),
      created_by_email: assignment.createdByEmail,
      created_at: assignment.createdAt.toISOString(),
      updated_at: assignment.updatedAt.toISOString(),
    })),
    app_keys: service.appKeys.map((key) => ({
      id: key.id,
      purpose: key.purpose.toLowerCase(),
      name: key.name,
      key_prefix: key.keyPrefix,
      actor_issuer: key.actorIssuer,
      actor_audience: key.actorAudience,
      actor_key_id: key.actorKeyId,
      checkout_return_origins: key.checkoutReturnOrigins,
      last_used_at: key.lastUsedAt?.toISOString() ?? null,
      expires_at: key.expiresAt?.toISOString() ?? null,
      revoked_at: key.revokedAt?.toISOString() ?? null,
      created_by_email: key.createdByEmail,
      created_at: key.createdAt.toISOString(),
    })),
    adjustments: service.adjustments.map((adjustment) => ({
      id: adjustment.id,
      service_id: adjustment.serviceId,
      key: adjustment.key,
      name: adjustment.name,
      kind: adjustment.kind.toLowerCase(),
      cadence: adjustment.cadence.toLowerCase(),
      amount_minor: adjustment.amountMinor.toString(),
      currency: adjustment.currency,
      scope: adjustment.scope.toLowerCase(),
      scope_key: adjustment.scopeKey,
      organisation: adjustment.org,
      team: adjustment.team,
      starts_at: adjustment.startsAt.toISOString(),
      ends_at: adjustment.endsAt?.toISOString() ?? null,
      active: adjustment.active,
      created_by_email: adjustment.createdByEmail,
      created_at: adjustment.createdAt.toISOString(),
      updated_at: adjustment.updatedAt.toISOString(),
    })),
    stripe_catalogs: service.stripeCatalogs.map((catalog) => ({
      id: catalog.id,
      account_id: catalog.accountId,
      stripe_account_id: catalog.account.stripeAccountId,
      livemode: catalog.account.livemode,
      currency: catalog.currency,
      meter_event_name: catalog.meterEventName,
      stripe_product_id: catalog.stripeProductId,
      stripe_meter_id: catalog.stripeMeterId,
      stripe_usage_price_id: catalog.stripeUsagePriceId,
      tariff_prices: catalog.tariffPrices.map((price) => ({
        id: price.id,
        tariff_id: price.tariffId,
        monthly_amount_minor: price.monthlyAmountMinor.toString(),
        stripe_monthly_price_id: price.stripeMonthlyPriceId,
      })),
    })),
    stripe_subscriptions: service.stripeSubscriptions.map((subscription) => ({
      id: subscription.id,
      account_id: subscription.accountId,
      stripe_account_id: subscription.account.stripeAccountId,
      checkout_id: subscription.checkoutId,
      tariff_id: subscription.tariffId,
      tariff_source: subscription.tariffSource.toLowerCase(),
      tariff_assignment_id: subscription.tariffAssignmentId,
      scope: subscription.scope.toLowerCase(),
      scope_key: subscription.scopeKey,
      organisation: subscription.org,
      team: subscription.team,
      stripe_subscription_id: subscription.stripeSubscriptionId,
      stripe_monthly_item_id: subscription.stripeMonthlyItemId,
      stripe_usage_item_id: subscription.stripeUsageItemId,
      status: subscription.status,
      cancel_at_period_end: subscription.cancelAtPeriodEnd,
      current_period_start: subscription.currentPeriodStart?.toISOString() ?? null,
      current_period_end: subscription.currentPeriodEnd?.toISOString() ?? null,
      livemode: subscription.livemode,
      created_at: subscription.createdAt.toISOString(),
      updated_at: subscription.updatedAt.toISOString(),
    })),
    created_at: service.createdAt.toISOString(),
    updated_at: service.updatedAt.toISOString(),
  };
}
