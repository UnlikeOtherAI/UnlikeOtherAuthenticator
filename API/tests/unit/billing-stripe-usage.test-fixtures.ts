import {
  BillingAssignmentScope,
  BillingCollectionMode,
  BillingTariffMode,
  BillingTariffSource,
} from '@prisma/client';

import type { NormalizedMeteringUsage } from '../../src/services/billing-metering.types.js';

export const capturedAt = new Date('2026-07-19T12:00:00.000Z');
export const stripeAccount = {
  id: 'stripe_account_test',
  stripeAccountId: 'acct_uoa',
  livemode: false,
  createdAt: capturedAt,
  updatedAt: capturedAt,
};

export function subscriptionFixture() {
  return {
    id: 'subscription_1',
    accountId: stripeAccount.id,
    checkoutId: 'checkout_1',
    customerId: 'customer_1',
    serviceId: 'service_1',
    tariffId: 'tariff_1',
    tariffSource: BillingTariffSource.TEAM,
    tariffAssignmentId: 'assignment_1',
    orgId: 'org_1',
    teamId: 'team_1',
    scope: BillingAssignmentScope.TEAM,
    scopeKey: 'org_1:team_1',
    stripeSubscriptionId: 'sub_1',
    stripeMonthlyItemId: 'si_monthly',
    stripeUsageItemId: 'si_usage',
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
    livemode: false,
    createdAt: capturedAt,
    updatedAt: capturedAt,
    account: stripeAccount,
    customer: {
      id: 'customer_1',
      accountId: stripeAccount.id,
      orgId: 'org_1',
      teamId: 'team_1',
      scope: BillingAssignmentScope.TEAM,
      scopeKey: 'org_1:team_1',
      stripeCustomerId: 'cus_1',
      createdAt: capturedAt,
      updatedAt: capturedAt,
    },
    service: {
      id: 'service_1',
      identifier: 'deepwater',
      name: 'DeepWater',
      active: true,
      createdAt: capturedAt,
      updatedAt: capturedAt,
    },
    tariff: {
      id: 'tariff_1',
      serviceId: 'service_1',
      key: 'standard',
      version: 4,
      name: 'Standard',
      mode: BillingTariffMode.STANDARD,
      collectionMode: BillingCollectionMode.STRIPE,
      markupBps: 2500,
      monthlyAmountMinor: 2999n,
      currency: 'USD',
      isDefault: false,
      createdByUserId: null,
      createdByEmail: null,
      createdAt: capturedAt,
      stripePrices: [
        {
          id: 'price_map_1',
          accountId: stripeAccount.id,
          tariffId: 'tariff_1',
          catalogId: 'catalog_1',
          monthlyAmountMinor: 2999n,
          stripeMonthlyPriceId: 'price_monthly_1',
          createdAt: capturedAt,
          catalog: {
            id: 'catalog_1',
            accountId: stripeAccount.id,
            serviceId: 'service_1',
            currency: 'USD',
            meterEventName: 'uoa_rated_hash',
            stripeProductId: 'prod_1',
            stripeMeterId: 'mtr_1',
            stripeUsagePriceId: 'price_usage_1',
            createdAt: capturedAt,
            updatedAt: capturedAt,
          },
        },
      ],
    },
  };
}

export function usageFixture(
  rawProviderCost = '2',
  cursor = 'mus_0123456789ABCDEFGHIJKLMNOPQRSTUV',
): NormalizedMeteringUsage {
  return {
    schemaVersion: 1,
    product: 'deepwater',
    groupBy: 'service',
    scope: {
      organizationId: 'org_1',
      teamId: 'team_1',
      userId: null,
      month: '2026-07',
      startsAt: '2026-07-01T00:00:00.000Z',
      endsAt: '2026-08-01T00:00:00.000Z',
    },
    calls: '2',
    lines: [
      {
        serviceId: 'openai',
        usageUnit: 'tokens',
        calls: '2',
        inputUnits: '100',
        cachedInputUnits: '10',
        outputUnits: '25',
        estimatedProviderCost: null,
        actualProviderCost: rawProviderCost,
        selectedProviderCost: rawProviderCost,
        currency: 'USD',
        costProvenance: 'provider_invoice',
        billingProduct: 'deepwater',
        callerProduct: 'deepsignal',
        originProduct: 'nessie',
        userId: null,
      },
    ],
    snapshot: {
      cursor,
      id: cursor,
      capturedAt: capturedAt.toISOString(),
      immutable: true,
      sha256: 'a'.repeat(64),
    },
  };
}
