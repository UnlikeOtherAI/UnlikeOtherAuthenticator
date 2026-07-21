import { describe, expect, it, vi } from 'vitest';

import { reconcileLocalStripeCommercialCatalog } from '../../src/services/billing-stripe-catalog-provisioning-local.service.js';
import {
  CREDIT_AUTO_TOP_UP_SPEC,
  CREDIT_FUNDING_POLICY_SPEC,
  CREDIT_TOP_UP_SPECS,
  DEEPWATER_PRIVACY_SPEC,
} from '../../src/services/billing-stripe-catalog-provisioning-spec.js';

const services = ['nessie', 'deepwater', 'deepsignal', 'deeptest'].map((identifier) => ({
  id: `service_${identifier}`,
  identifier,
  name: identifier,
  active: true,
}));

const catalog = {
  stripeAccountId: 'acct_uoa',
  livemode: false,
  creditPrices: CREDIT_TOP_UP_SPECS.map((spec) => ({
    key: spec.catalogKey,
    version: spec.catalogVersion,
    stripeLookupKey: spec.stripeLookupKey,
    stripeProductId: 'prod_credits',
    stripePriceId: `price_${spec.catalogKey}`,
  })),
  recurringAddon: {
    stripeLookupKey: 'deepwater_privacy_usd_month_v1',
    stripeProductId: 'prod_privacy',
    stripePriceId: 'price_privacy',
  },
};

function emptyLocalCatalog(activeServices = services) {
  return {
    billingService: { findMany: vi.fn().mockResolvedValue(activeServices) },
    app: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'app_deepwater',
          identifier: 'deepwater-api',
          featureFlagsEnabled: true,
        },
      ]),
    },
    featureFlagDefinition: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    billingStripeAccount: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    billingCreditFundingPolicy: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    billingCreditTopUpCatalog: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    billingCreditTopUpOffer: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    billingCreditAutoTopUpOption: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    billingRecurringAddonOffer: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    billingRecurringAddonFeaturePolicy: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    billingRecurringAddonCatalog: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
}

function completeLocalCatalog() {
  const policies = new Map(
    services.map((service) => [
      service.id,
      {
        id: `policy_${service.identifier}`,
        serviceId: service.id,
        ...CREDIT_FUNDING_POLICY_SPEC,
        active: true,
        deactivatedAt: null,
      },
    ]),
  );
  const offers = new Map(
    [...policies.values()].map((policy) => [
      policy.id,
      CREDIT_TOP_UP_SPECS.map((spec) => ({
        id: `offer_${policy.serviceId}_${spec.key}`,
        policyId: policy.id,
        serviceId: policy.serviceId,
        key: spec.key,
        version: spec.version,
        catalogKey: spec.catalogKey,
        catalogVersion: spec.catalogVersion,
        name: spec.name,
        description: spec.description,
        paymentAmountMinor: spec.paymentAmountMinor,
        creditsReceivedMicrocredits: spec.creditsReceivedMicrocredits,
        automaticTopUpEligible: true,
        active: true,
        deactivatedAt: null,
      })),
    ]),
  );
  const deepwater = services.find((service) => service.identifier === 'deepwater');
  if (!deepwater) throw new Error('missing test service');
  const addonOffer = {
    id: 'offer_privacy',
    serviceId: deepwater.id,
    key: DEEPWATER_PRIVACY_SPEC.key,
    version: DEEPWATER_PRIVACY_SPEC.version,
    name: DEEPWATER_PRIVACY_SPEC.name,
    description: DEEPWATER_PRIVACY_SPEC.description,
    benefits: [...DEEPWATER_PRIVACY_SPEC.benefits],
    monthlyAmountMinor: DEEPWATER_PRIVACY_SPEC.monthlyAmountMinor,
    currency: DEEPWATER_PRIVACY_SPEC.currency,
    active: true,
    deactivatedAt: null,
  };
  const create = vi.fn();
  return {
    billingService: { findMany: vi.fn().mockResolvedValue(services) },
    app: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: 'app_deepwater', identifier: 'deepwater-api', featureFlagsEnabled: true },
        ]),
    },
    featureFlagDefinition: {
      findUnique: vi.fn().mockResolvedValue({
        defaultState: false,
        description: DEEPWATER_PRIVACY_SPEC.featureFlagDescription,
      }),
      create,
    },
    billingStripeAccount: {
      findUnique: vi.fn().mockResolvedValue({ id: 'account_1' }),
      create,
    },
    billingCreditFundingPolicy: {
      findMany: vi.fn(({ where }) => Promise.resolve([policies.get(where.serviceId)])),
      create,
    },
    billingCreditTopUpCatalog: {
      findMany: vi.fn().mockResolvedValue(
        CREDIT_TOP_UP_SPECS.map((spec) => {
          const remote = catalog.creditPrices.find((price) => price.key === spec.catalogKey);
          return {
            id: `catalog_${spec.catalogKey}`,
            accountId: 'account_1',
            key: spec.catalogKey,
            version: spec.catalogVersion,
            currency: 'USD',
            paymentAmountMinor: spec.paymentAmountMinor,
            creditsReceivedMicrocredits: spec.creditsReceivedMicrocredits,
            stripeLookupKey: spec.stripeLookupKey,
            stripeProductId: remote?.stripeProductId,
            stripePriceId: remote?.stripePriceId,
          };
        }),
      ),
      create,
      update: vi.fn(),
    },
    billingCreditTopUpOffer: {
      findMany: vi.fn(({ where }) => Promise.resolve(offers.get(where.policyId))),
      create,
    },
    billingCreditAutoTopUpOption: {
      findMany: vi.fn(({ where }) => {
        const refill = offers
          .get(where.policyId)
          ?.find((offer) => offer.key === CREDIT_AUTO_TOP_UP_SPEC.refillOfferKey);
        return Promise.resolve([
          {
            id: `option_${where.policyId}`,
            policyId: where.policyId,
            serviceId: refill?.serviceId,
            refillOfferId: refill?.id,
            key: CREDIT_AUTO_TOP_UP_SPEC.key,
            version: CREDIT_AUTO_TOP_UP_SPEC.version,
            thresholdMicrocredits: CREDIT_AUTO_TOP_UP_SPEC.thresholdMicrocredits,
            monthlyChargeCapMinor: CREDIT_AUTO_TOP_UP_SPEC.monthlyChargeCapMinor,
            active: true,
            deactivatedAt: null,
          },
        ]);
      }),
      create,
    },
    billingRecurringAddonOffer: {
      findMany: vi.fn().mockResolvedValue([addonOffer]),
      create,
    },
    billingRecurringAddonFeaturePolicy: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'policy_privacy',
          serviceId: deepwater.id,
          offerId: addonOffer.id,
          appId: 'app_deepwater',
          featureFlagKey: DEEPWATER_PRIVACY_SPEC.featureFlagKey,
          entitlementScope: 'TEAM',
          active: true,
        },
      ]),
      create,
    },
    billingRecurringAddonCatalog: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'catalog_privacy',
          accountId: 'account_1',
          serviceId: deepwater.id,
          offerId: addonOffer.id,
          currency: DEEPWATER_PRIVACY_SPEC.currency,
          monthlyAmountMinor: DEEPWATER_PRIVACY_SPEC.monthlyAmountMinor,
          stripeLookupKey: catalog.recurringAddon.stripeLookupKey,
          stripeProductId: catalog.recurringAddon.stripeProductId,
          stripePriceId: catalog.recurringAddon.stripePriceId,
        },
      ]),
      create,
      update: vi.fn(),
    },
  };
}

describe('local Stripe commercial catalog reconciliation', () => {
  it('plans the complete four-service catalog without writing in dry-run mode', async () => {
    const db = emptyLocalCatalog();
    const actions = await reconcileLocalStripeCommercialCatalog({
      db: db as never,
      catalog,
      write: false,
    });

    expect(actions).toHaveLength(33);
    expect(actions.every((action) => action.outcome === 'created')).toBe(true);
    expect(actions).toContainEqual({
      resource: 'credit_auto_top_up_option',
      key: 'nessie/default/v1',
      outcome: 'created',
    });
    expect(actions).toContainEqual({
      resource: 'recurring_addon_feature_policy',
      key: 'deepwater/privacy/team',
      outcome: 'created',
    });
    expect(db.featureFlagDefinition.create).not.toHaveBeenCalled();
    expect(db.billingStripeAccount.create).not.toHaveBeenCalled();
  });

  it('fails closed rather than leaving an unprovisioned active service', async () => {
    const db = emptyLocalCatalog([
      ...services,
      { id: 'service_future', identifier: 'future', name: 'future', active: true },
    ]);

    await expect(
      reconcileLocalStripeCommercialCatalog({ db: db as never, catalog, write: false }),
    ).rejects.toThrow('BILLING_COMMERCIAL_CATALOG_LOCAL_DRIFT');
  });

  it('is a complete no-op when every immutable row is already exact', async () => {
    const db = completeLocalCatalog();
    const actions = await reconcileLocalStripeCommercialCatalog({
      db: db as never,
      catalog,
      write: true,
    });

    expect(actions).toHaveLength(33);
    expect(actions.every((action) => action.outcome === 'no-op')).toBe(true);
    expect(db.featureFlagDefinition.create).not.toHaveBeenCalled();
    expect(db.billingCreditTopUpCatalog.update).not.toHaveBeenCalled();
    expect(db.billingRecurringAddonCatalog.update).not.toHaveBeenCalled();
  });

  it('performs only the first exact binding when both local Stripe IDs are null', async () => {
    const db = completeLocalCatalog();
    const creditRows = await db.billingCreditTopUpCatalog.findMany();
    const credit = creditRows[0];
    if (!credit) throw new Error('missing test credit catalog');
    credit.stripeProductId = null;
    credit.stripePriceId = null;
    db.billingCreditTopUpCatalog.findMany.mockResolvedValue(creditRows);
    const addonRows = await db.billingRecurringAddonCatalog.findMany();
    const addon = addonRows[0];
    if (!addon) throw new Error('missing test recurring add-on catalog');
    addon.stripeProductId = null;
    addon.stripePriceId = null;
    db.billingRecurringAddonCatalog.findMany.mockResolvedValue(addonRows);

    const actions = await reconcileLocalStripeCommercialCatalog({
      db: db as never,
      catalog,
      write: true,
    });

    expect(db.billingCreditTopUpCatalog.update).toHaveBeenCalledWith({
      where: { id: credit.id },
      data: {
        stripeProductId: catalog.creditPrices[0]?.stripeProductId,
        stripePriceId: catalog.creditPrices[0]?.stripePriceId,
      },
    });
    expect(db.billingRecurringAddonCatalog.update).toHaveBeenCalledWith({
      where: { id: addon.id },
      data: {
        stripeProductId: catalog.recurringAddon.stripeProductId,
        stripePriceId: catalog.recurringAddon.stripePriceId,
      },
    });
    expect(actions.filter((action) => action.outcome === 'created')).toHaveLength(2);
  });

  it('rejects a partial credit catalog binding instead of filling around it', async () => {
    const db = completeLocalCatalog();
    const rows = await db.billingCreditTopUpCatalog.findMany();
    const first = rows[0];
    if (!first) throw new Error('missing test credit catalog');
    first.stripeProductId = null;
    db.billingCreditTopUpCatalog.findMany.mockResolvedValue(rows);

    await expect(
      reconcileLocalStripeCommercialCatalog({ db: db as never, catalog, write: true }),
    ).rejects.toThrow('BILLING_COMMERCIAL_CATALOG_LOCAL_DRIFT');

    expect(db.billingCreditTopUpCatalog.update).not.toHaveBeenCalled();
  });

  it('rejects a partial recurring add-on catalog binding instead of overwriting it', async () => {
    const db = completeLocalCatalog();
    const rows = await db.billingRecurringAddonCatalog.findMany();
    const first = rows[0];
    if (!first) throw new Error('missing test recurring add-on catalog');
    first.stripePriceId = null;
    db.billingRecurringAddonCatalog.findMany.mockResolvedValue(rows);

    await expect(
      reconcileLocalStripeCommercialCatalog({ db: db as never, catalog, write: true }),
    ).rejects.toThrow('BILLING_COMMERCIAL_CATALOG_LOCAL_DRIFT');

    expect(db.billingRecurringAddonCatalog.update).not.toHaveBeenCalled();
  });
});
