import { describe, expect, it, vi } from 'vitest';

import { assertCreditCatalogPrice } from '../../src/services/billing-credit-funding-context.service.js';

const account = { id: 'account_1', stripeAccountId: 'acct_uoa', livemode: false };
const catalog = {
  stripeLookupKey: 'uoa-credits-20k-v1',
  stripeProductId: 'prod_credits_20k',
  stripePriceId: 'price_credits_20k',
  paymentAmountMinor: 2_000n,
};

function remotePrice(amount = 2_000) {
  return {
    id: catalog.stripePriceId,
    livemode: false,
    active: true,
    type: 'one_time',
    currency: 'usd',
    unit_amount: amount,
    lookup_key: catalog.stripeLookupKey,
    product: {
      id: catalog.stripeProductId,
      livemode: false,
      active: true,
    },
  };
}

describe('credit funding Stripe catalog verification', () => {
  it('accepts only the exact active account/mode product, lookup key, and fixed amount', async () => {
    const retrieve = vi.fn().mockResolvedValue(remotePrice());

    await assertCreditCatalogPrice({ prices: { retrieve } } as never, account, catalog);

    expect(retrieve).toHaveBeenCalledWith(catalog.stripePriceId, { expand: ['product'] });
  });

  it('fails closed when the current Stripe Price amount drifts from UOA policy', async () => {
    await expect(
      assertCreditCatalogPrice(
        { prices: { retrieve: vi.fn().mockResolvedValue(remotePrice(1)) } } as never,
        account,
        catalog,
      ),
    ).rejects.toThrow('STRIPE_CREDIT_CATALOG_BINDING_INVALID');
  });
});
