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
  stripeCollectionEnabled: true,scopeEpoch:'2026-11-08T00:00:00.000Z',modeRevision:0,
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
        resourceKind: null,
        resourceId: null,
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
            stripeProductId: 'prod_privacy',
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
        offerId: 'offer_privacy', teamId:request.teamId,
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
    checkouts: [],retainedSubscriptions:[],
  };
}

function dependencies(
  data: ReturnType<typeof addonData>,
  billingManager: boolean,
  collectionContext = collection,
) {
  return {
    now: () => now,
    resolveEntitlement: vi.fn().mockResolvedValue({ actor: {}, payload: {} }),
    resolveCollection: vi.fn().mockResolvedValue(collectionContext),
    resolveMode:vi.fn().mockResolvedValue({mode:collectionContext.account.livemode?'live':'sandbox',
      epoch:collectionContext.scopeEpoch,revision:collectionContext.modeRevision}),
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
  it('refuses a display after mode/revision drift or manager revocation during the read',async()=>{
    for(const change of ['mode','revision','epoch','manager']){
      const deps=dependencies(addonData(BillingRecurringAddonSubscriptionScope.TEAM,
        BillingRecurringAddonEntitlementScope.TEAM,null),true);
      if(change==='manager')deps.resolveViewer.mockResolvedValueOnce({billingManager:true}).mockResolvedValue({billingManager:false});
      else deps.resolveMode.mockResolvedValue({mode:change==='mode'?'live':'sandbox',
        epoch:change==='epoch'?'2026-11-09T00:00:00.000Z':collection.scopeEpoch,revision:change==='revision'?1:0});
      await expect(getBillingRecurringAddons({request,actorToken:'signed-actor',credential,supportsBillingMode:true},deps as never))
        .rejects.toMatchObject({statusCode:change==='manager'?403:409});
    }
  });
  it('freezes subscribe when the persisted Stripe catalog binding is incomplete', async () => {
    const data = addonData(
      BillingRecurringAddonSubscriptionScope.TEAM,
      BillingRecurringAddonEntitlementScope.TEAM,
      null,
    );
    data.subscriptions = [];
    data.offers[0]!.catalogs = [
      { ...data.offers[0]!.catalogs[0]!, stripeProductId: null },
    ] as never;

    const result = await getBillingRecurringAddons(
      { request, actorToken: 'signed-actor', credential, supportsBillingMode:true, locale: 'cs' },
      dependencies(data, true) as never,
    );

    expect(result).toMatchObject({
      capabilities: { can_manage_addons: false },
      offers: [
        {
          available: false,
          unavailable_reason: 'Platba není pro tuto nabídku nastavená.',
          name: 'Soukromí',
          description: 'Soukromý výzkum pro tento tým.',
          actions: [{ id: 'subscribe', enabled: false }],
        },
      ],
    });
    expect(result.title).toBe('DeepWater doplňky');
  });

  it('keeps the read projection available while collection actions are frozen', async () => {
    const result = await getBillingRecurringAddons(
      { request, actorToken: 'signed-actor', credential, supportsBillingMode:true, locale: 'cs' },
      dependencies(
        addonData(
          BillingRecurringAddonSubscriptionScope.TEAM,
          BillingRecurringAddonEntitlementScope.TEAM,
          null,
        ),
        true,
        { ...collection, stripeCollectionEnabled: false },
      ) as never,
    );

    expect(result).toMatchObject({
      collection: { stripe_collection_enabled: false, stripe_mode: 'test' },
      capabilities: { can_manage_addons: false },
      offers: [{ actions: [{ id: 'cancel', enabled: false }] }],
    });
    expect(result.offers[0]?.monthly_price.display).toBe('50,00\u00a0US$ / měsíc');
  });

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
  ])(
    'refuses $scope financial reads to an ordinary member before reading funding',
    async ({ scope, entitlementScope, userId }) => {
      const deps=dependencies(addonData(scope,entitlementScope,userId),false);
      await expect(getBillingRecurringAddons({request,actorToken:'signed-actor',credential,supportsBillingMode:true},deps as never))
        .rejects.toMatchObject({statusCode:403,message:'BILLING_MANAGER_REQUIRED'});
      expect(deps.resolveCollection).not.toHaveBeenCalled();expect(deps.loadData).not.toHaveBeenCalled();
    },
  );

  it('gives billing managers the exact subscription and subscribing-user identity', async () => {
    const result = await getBillingRecurringAddons(
      { request, actorToken: 'signed-actor', credential, supportsBillingMode:true },
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
      capabilities: { can_manage_addons: true },
      offers: [
        {
          subscription: {
            id: 'subscription_secret',
            owner_user_id: 'user_secret_other',
          },
          actions: [
            {
              id: 'cancel',
              enabled: true,
              request: {
                body: {
                  subscription_id: 'subscription_secret',
                  organisation_id: request.organisationId,
                  team_id: request.teamId,
                  user_id: request.userId,
                },
              },
            },
          ],
        },
      ],
    });
  });
});
