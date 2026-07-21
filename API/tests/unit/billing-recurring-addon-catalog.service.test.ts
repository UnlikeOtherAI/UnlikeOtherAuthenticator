import { describe, expect, it, vi } from 'vitest';

import { ensureRecurringAddonStripeCatalog } from '../../src/services/billing-recurring-addon-catalog.service.js';

const account = { id: 'account_1', stripeAccountId: 'acct_uoa', livemode: false };
const offer = {
  id: 'offer_1',
  serviceId: 'service_1',
  key: 'privacy',
  version: 1,
  currency: 'USD',
  monthlyAmountMinor: 5_000n,
};
const catalog = {
  id: 'catalog_1',
  accountId: account.id,
  serviceId: offer.serviceId,
  offerId: offer.id,
  currency: offer.currency,
  monthlyAmountMinor: offer.monthlyAmountMinor,
  stripeLookupKey: 'deepwater_privacy_usd_month_v1',
  stripeProductId: 'prod_privacy',
  stripePriceId: 'price_privacy',
};

function remoteCatalog(productMetadata?: Record<string, string>) {
  return {
    product: {
      id: catalog.stripeProductId,
      livemode: false,
      active: true,
      metadata: productMetadata ?? {
        contract_version: '1',
        uoa_addon_key: 'privacy',
        uoa_kind: 'recurring_addon',
        uoa_service: 'deep-water',
      },
    },
    price: {
      id: catalog.stripePriceId,
      livemode: false,
      active: true,
      type: 'recurring',
      currency: 'usd',
      unit_amount: 5_000,
      unit_amount_decimal: '5000',
      lookup_key: catalog.stripeLookupKey,
      product: catalog.stripeProductId,
      recurring: {
        interval: 'month',
        interval_count: 1,
        usage_type: 'licensed',
        meter: null,
      },
      metadata: {
        uoa_addon_key: 'privacy',
        uoa_kind: 'recurring_addon',
        uoa_service: 'deep-water',
      },
    },
  };
}

function dependencies(remote = remoteCatalog()) {
  return {
    stripe: {
      products: { retrieve: vi.fn().mockResolvedValue(remote.product) },
      prices: { retrieve: vi.fn().mockResolvedValue(remote.price) },
    },
    prisma: {
      billingRecurringAddonCatalog: {
        update: vi.fn(),
        findUniqueOrThrow: vi.fn(),
      },
    },
  };
}

describe('recurring add-on Stripe catalog validation', () => {
  it('accepts the provisioned stable DeepWater metadata and exact monthly terms', async () => {
    const deps = dependencies();

    await expect(
      ensureRecurringAddonStripeCatalog(
        {
          catalog,
          offer,
          serviceIdentifier: 'deepwater',
          serviceName: 'DeepWater',
          account,
          stripe: deps.stripe,
        } as never,
        { prisma: deps.prisma } as never,
      ),
    ).resolves.toBe(catalog);

    expect(deps.prisma.billingRecurringAddonCatalog.update).not.toHaveBeenCalled();
  });

  it('rejects legacy local database identifiers in Stripe metadata', async () => {
    const deps = dependencies(
      remoteCatalog({
        uoa_binding_kind: 'recurring_addon_catalog',
        uoa_recurring_addon_catalog_id: catalog.id,
        uoa_service_id: offer.serviceId,
        uoa_offer_id: offer.id,
        uoa_offer_key: offer.key,
        uoa_offer_version: offer.version.toString(),
        uoa_stripe_account_id: account.stripeAccountId,
        uoa_stripe_mode: 'test',
      }),
    );

    await expect(
      ensureRecurringAddonStripeCatalog(
        {
          catalog,
          offer,
          serviceIdentifier: 'deepwater',
          serviceName: 'DeepWater',
          account,
          stripe: deps.stripe,
        } as never,
        { prisma: deps.prisma } as never,
      ),
    ).rejects.toThrow('STRIPE_RECURRING_ADDON_CATALOG_DRIFT');
  });
});
