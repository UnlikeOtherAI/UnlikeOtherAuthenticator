import {
  BillingAppKeyPurpose,
  BillingRecurringAddonEntitlementScope,
  BillingRecurringAddonSubscriptionScope,
} from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { assertBillingRecurringAddonsContract } from '../../src/routes/billing/recurring-addons.js';
import { getBillingRecurringAddons } from '../../src/services/billing-recurring-addons.service.js';

const now = new Date('2026-07-21T12:00:00.000Z');
const credential = {
  id: 'app_key_deepwater',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://api.deepwater.example',
  actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
  actorKeyId: 'actor_key_1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.deepwater.example'],
  service: { id: 'service_deepwater', identifier: 'deepwater', name: 'DeepWater' },
};
const request = {
  product: 'deepwater',
  organisationId: 'org_1',
  teamId: 'team_1',
  userId: 'user_viewer',
};
const collection = {
  account: {
    id: 'stripe_account_1',
    stripeAccountId: 'acct_uoa',
    livemode: false,
    createdAt: now,
    updatedAt: now,
  },
  stripeCollectionEnabled: true,
};

function addonData(
  scope: BillingRecurringAddonSubscriptionScope,
  entitlementScope: BillingRecurringAddonEntitlementScope,
  subscribingUserId: string | null,
) {
  return {
    offers: [
      {
        id: 'offer_privacy',
        serviceId: credential.service.id,
        key: 'privacy',
        version: 1,
        name: 'Private research',
        description: 'Keep eligible research private.',
        benefits: ['Private eligible research'],
        monthlyAmountMinor: 5000n,
        currency: 'USD',
        featurePolicies: [{ entitlementScope }],
        catalogs: [
          {
            stripePriceId: 'price_privacy',
            currency: 'USD',
            monthlyAmountMinor: 5000n,
          },
        ],
      },
    ],
    subscriptions: [
      {
        id: 'subscription_secret',
        offerId: 'offer_privacy',
        scope,
        subscribingUserId,
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
        entitlementActivatedAt: new Date('2026-07-01T00:01:00.000Z'),
        entitlementDeactivatedAt: null,
        updatedAt: now,
      },
    ],
  };
}

function dependencies(
  data: ReturnType<typeof addonData>,
  billingManager: boolean,
) {
  return {
    now: () => now,
    resolveEntitlement: vi.fn().mockResolvedValue({ actor: {}, payload: {} }),
    resolveCollection: vi.fn().mockResolvedValue(collection),
    resolveViewer: vi.fn().mockResolvedValue({
      userId: request.userId,
      displayName: 'Viewer',
      organisationId: request.organisationId,
      teamId: request.teamId,
      organisationRole: billingManager ? 'admin' : 'member',
      teamRole: 'member',
      billingManager,
    }),
    loadData: vi.fn().mockResolvedValue(data),
  };
}

describe('privacy-safe recurring add-on scopes', () => {
  it.each([
    {
      scope: BillingRecurringAddonSubscriptionScope.ORGANISATION,
      entitlementScope: BillingRecurringAddonEntitlementScope.ORGANISATION,
      userId: null,
      relationship: 'organisation',
    },
    {
      scope: BillingRecurringAddonSubscriptionScope.TEAM,
      entitlementScope: BillingRecurringAddonEntitlementScope.TEAM,
      userId: null,
      relationship: 'team',
    },
    {
      scope: BillingRecurringAddonSubscriptionScope.SUBSCRIBING_USER,
      entitlementScope: BillingRecurringAddonEntitlementScope.SUBSCRIBING_USER,
      userId: 'user_viewer',
      relationship: 'viewer',
    },
    {
      scope: BillingRecurringAddonSubscriptionScope.SUBSCRIBING_USER,
      entitlementScope: BillingRecurringAddonEntitlementScope.SUBSCRIBING_USER,
      userId: 'user_secret_other',
      relationship: 'other_team_member',
    },
  ])('shows $scope entitlement without leaking owner identity to members', async ({
    scope,
    entitlementScope,
    userId,
    relationship,
  }) => {
    const result = await getBillingRecurringAddons(
      { request, actorToken: 'signed-actor', credential },
      dependencies(addonData(scope, entitlementScope, userId), false) as never,
    );
    const serialized = JSON.stringify(result);

    expect(() => assertBillingRecurringAddonsContract(result)).not.toThrow();
    expect(result).toMatchObject({
      viewer: { role: 'member' },
      capabilities: { can_manage_addons: false },
      offers: [
        {
          key: 'privacy',
          monthly_price: { amount: '50', amount_minor: '5000' },
          entitlement: { state: 'active' },
          subscription: { owner_relationship: relationship },
          actions: [],
        },
      ],
    });
    expect(serialized).not.toContain('subscription_secret');
    expect(serialized).not.toContain('user_secret_other');
  });

  it('gives billing managers the exact subscription and subscribing-user identity', async () => {
    const result = await getBillingRecurringAddons(
      { request, actorToken: 'signed-actor', credential },
      dependencies(
        addonData(
          BillingRecurringAddonSubscriptionScope.SUBSCRIBING_USER,
          BillingRecurringAddonEntitlementScope.SUBSCRIBING_USER,
          'user_secret_other',
        ),
        true,
      ) as never,
    );

    expect(() => assertBillingRecurringAddonsContract(result)).not.toThrow();
    expect(result).toMatchObject({
      viewer: { role: 'billing_manager' },
      capabilities: { can_manage_addons: false },
      offers: [
        {
          subscription: {
            id: 'subscription_secret',
            owner_user_id: 'user_secret_other',
          },
          actions: [],
        },
      ],
    });
  });
});
