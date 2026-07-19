import {
  BillingAssignmentScope,
  BillingCollectionMode,
  BillingTariffMode,
  BillingTariffSource,
} from '@prisma/client';

import type { LedgerBillingUsage } from '../../src/services/billing-ledger-collector.service.js';

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
  amount = '2.5',
  cursor = 'bus_0123456789ABCDEFGHIJKLMNOPQRSTUV',
): LedgerBillingUsage {
  return {
    schemaVersion: 4,
    product: 'deepwater',
    scope: {
      organizationId: 'org_1',
      teamId: 'team_1',
      userId: null,
      month: '2026-07',
      startsAt: '2026-07-01T00:00:00.000Z',
      endsAt: '2026-08-01T00:00:00.000Z',
    },
    totals: {
      calls: 2,
      usageByService: [],
      amounts: [],
      customerCharges: [
        {
          billingProduct: 'deepwater',
          callerProduct: 'deepsignal',
          currency: 'USD',
          amount,
          calls: 2,
        },
      ],
    },
    groupBy: 'service',
    breakdown: [],
    monthlyComponents: [
      {
        billingProduct: 'deepwater',
        callerProduct: 'deepsignal',
        tariffId: 'tariff_1',
        tariffKey: 'standard',
        tariffVersion: 4,
        tariffMode: 'standard',
        markupBps: 2500,
        usageMultiplierBps: 12500,
        assignmentScope: 'team',
        assignmentId: 'assignment_1',
        amountMinor: '2999',
        currency: 'USD',
        usageBillingEnabled: true,
        collectionMode: 'stripe',
        paymentCollectionEnabled: true,
      },
    ],
    snapshot: {
      cursor,
      capturedAt: capturedAt.toISOString(),
      immutable: true,
    },
  };
}
