import { describe, expect, it, vi } from 'vitest';

import {
  CREDIT_PRODUCT_METADATA,
  CREDIT_TOP_UP_SPECS,
  creditPriceMetadata,
  DEEPWATER_PRIVACY_SPEC,
  recurringAddonPriceMetadata,
  recurringAddonProductMetadata,
} from '../../src/services/billing-stripe-catalog-provisioning-spec.js';
import { validateStripeCommercialCatalog } from '../../src/services/billing-stripe-catalog-provisioning-remote.service.js';

const accountId = 'acct_uoa';
const creditProduct = {
  id: 'prod_credits',
  active: true,
  livemode: false,
  metadata: { ...CREDIT_PRODUCT_METADATA },
};
const addonMetadataSubject = {
  serviceIdentifier: DEEPWATER_PRIVACY_SPEC.serviceIdentifier,
  offerKey: DEEPWATER_PRIVACY_SPEC.key,
};
const addonProduct = {
  id: 'prod_privacy',
  active: true,
  livemode: false,
  metadata: recurringAddonProductMetadata({
    ...addonMetadataSubject,
    offerVersion: DEEPWATER_PRIVACY_SPEC.version,
  }),
};

function prices() {
  return [
    ...CREDIT_TOP_UP_SPECS.map((spec, index) => ({
      id: `price_credit_${index}`,
      active: true,
      livemode: false,
      lookup_key: spec.stripeLookupKey,
      currency: 'usd',
      type: 'one_time',
      recurring: null,
      unit_amount: Number(spec.paymentAmountMinor),
      unit_amount_decimal: spec.paymentAmountMinor.toString(),
      metadata: creditPriceMetadata(spec),
      product: creditProduct.id,
    })),
    {
      id: 'price_privacy',
      active: true,
      livemode: false,
      lookup_key: DEEPWATER_PRIVACY_SPEC.stripeLookupKey,
      currency: 'usd',
      type: 'recurring',
      recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', meter: null },
      unit_amount: Number(DEEPWATER_PRIVACY_SPEC.monthlyAmountMinor),
      unit_amount_decimal: DEEPWATER_PRIVACY_SPEC.monthlyAmountMinor.toString(),
      metadata: recurringAddonPriceMetadata(addonMetadataSubject),
      product: addonProduct.id,
    },
  ];
}

function stripe(remotePrices = prices()) {
  const products = new Map([
    [creditProduct.id, creditProduct],
    [addonProduct.id, addonProduct],
  ]);
  return {
    accounts: { retrieveCurrent: vi.fn().mockResolvedValue({ id: accountId }) },
    prices: {
      list: vi.fn().mockResolvedValue({ data: remotePrices, has_more: false }),
    },
    products: {
      retrieve: vi.fn((id: string) => Promise.resolve(products.get(id))),
    },
  };
}

describe('Stripe commercial catalog remote validation', () => {
  it('accepts the exact shared-credit and DeepWater privacy contracts', async () => {
    const result = await validateStripeCommercialCatalog({
      stripe: stripe() as never,
      expectedStripeAccountId: accountId,
      expectedLivemode: false,
    });

    expect(result.creditPrices).toHaveLength(4);
    expect(new Set(result.creditPrices.map((price) => price.stripeProductId))).toEqual(
      new Set([creditProduct.id]),
    );
    expect(result.recurringAddon).toEqual({
      stripeLookupKey: DEEPWATER_PRIVACY_SPEC.stripeLookupKey,
      stripeProductId: addonProduct.id,
      stripePriceId: 'price_privacy',
    });
  });

  it('fails closed when the authenticated Stripe account differs', async () => {
    await expect(
      validateStripeCommercialCatalog({
        stripe: stripe() as never,
        expectedStripeAccountId: 'acct_other',
        expectedLivemode: false,
      }),
    ).rejects.toThrow('STRIPE_COMMERCIAL_CATALOG_ACCOUNT_MISMATCH');
  });

  it('fails closed on immutable Price metadata drift', async () => {
    const remotePrices = prices();
    const first = remotePrices[0];
    if (first) first.metadata = { ...first.metadata, credits: '999' };

    await expect(
      validateStripeCommercialCatalog({
        stripe: stripe(remotePrices) as never,
        expectedStripeAccountId: accountId,
        expectedLivemode: false,
      }),
    ).rejects.toThrow('STRIPE_COMMERCIAL_CATALOG_DRIFT');
  });

  it('fails closed when privacy is not one licensed monthly Price', async () => {
    const remotePrices = prices();
    const privacy = remotePrices.at(-1);
    if (privacy) privacy.recurring = { ...privacy.recurring, interval_count: 2 } as never;

    await expect(
      validateStripeCommercialCatalog({
        stripe: stripe(remotePrices) as never,
        expectedStripeAccountId: accountId,
        expectedLivemode: false,
      }),
    ).rejects.toThrow('STRIPE_COMMERCIAL_CATALOG_DRIFT');
  });
});
