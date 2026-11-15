import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { expect, vi } from 'vitest';
import { provisionNessieTopUps } from '../../src/services/billing-nessie-top-up-catalog.service.js';
import { CREDIT_PRODUCT_METADATA, CREDIT_TOP_UP_SPECS, creditPriceMetadata } from '../../src/services/billing-stripe-catalog-provisioning-spec.js';
import { fundingRaceIds as ids, stripeAccount } from './billing-credit-funding-actions.persistence.fixture.js';

export async function publishManualOffers(prisma: PrismaClient) {
  const product = { id: 'prod_requested_credits', active: true, livemode: false, metadata: CREDIT_PRODUCT_METADATA };
  const asPrice = (input: Stripe.PriceCreateParams) => ({
    ...input, id: `price_${input.lookup_key!.slice(4, -3)}`, type: 'one_time', recurring: null,
    unit_amount_decimal: String(input.unit_amount), active: true, livemode: false, product: product.id,
  });
  const prices = new Map(CREDIT_TOP_UP_SPECS.map((spec) => [spec.stripeLookupKey, asPrice({
    lookup_key: spec.stripeLookupKey, currency: spec.currency.toLowerCase(),
    unit_amount: Number(spec.paymentAmountMinor), product: product.id, metadata: creditPriceMetadata(spec),
  })]));
  const create = vi.fn(async (params: Stripe.PriceCreateParams) => {
    const price = asPrice(params);
    prices.set(params.lookup_key!, price);
    return price;
  });
  const stripe = {
    accounts: { retrieveCurrent: async () => ({ id: stripeAccount.stripeAccountId }) },
    products: { retrieve: async () => product },
    prices: { create, retrieve: async (id: string) => [...prices.values()].find((row) => row.id === id),
      list: async (query: { lookup_keys: string[] }) => ({
        has_more: false, data: [...prices.values()].filter((row) => query.lookup_keys.includes(row.lookup_key!)),
      }) },
  } as unknown as Stripe;
  const basis = CREDIT_TOP_UP_SPECS.find((spec) => spec.key === 'credits_usd_10')!;
  await prisma.billingCreditTopUpCatalog.create({ data: { accountId: ids.account, version: 1,
    key: basis.key, currency: 'USD', paymentAmountMinor: basis.paymentAmountMinor,
    creditsReceivedMicrocredits: basis.creditsReceivedMicrocredits, stripeLookupKey: basis.stripeLookupKey,
    stripeProductId: product.id, stripePriceId: prices.get(basis.stripeLookupKey)!.id } });
  const config = { prisma, stripe, expectedLivemode: false, expectedStripeAccountId: stripeAccount.stripeAccountId };
  await expect(provisionNessieTopUps({ ...config, expectedStripeAccountId: 'acct_wrong', dryRun: false }))
    .rejects.toThrow('STRIPE_COMMERCIAL_CATALOG_ACCOUNT_MISMATCH');
  const preview = await provisionNessieTopUps({ ...config, dryRun: true });
  expect(preview.stripe_prices_to_create).toHaveLength(9);
  expect(create).not.toHaveBeenCalled();
  const initialOffers = await prisma.billingCreditTopUpOffer.count({ where: { serviceId: ids.service } });
  expect(initialOffers).toBe(1);
  await provisionNessieTopUps({ ...config, dryRun: false });
  const replay = await provisionNessieTopUps({ ...config, dryRun: false });
  expect(create).toHaveBeenCalledTimes(9);
  expect(replay.stripe_prices_to_create).toEqual([]);
  expect(replay.actions.every((action) => action.outcome === 'no-op')).toBe(true);
  const retired = await prisma.billingCreditTopUpOffer.findUniqueOrThrow({ where: { id: ids.offer } });
  expect(retired.manualPurchaseEnabled).toBe(false);
  expect(retired.automaticTopUpEligible).toBe(true);
  expect((await prisma.billingCreditAutoTopUpOption.findUniqueOrThrow({ where: { id: ids.option } })).refillOfferId).toBe(ids.offer);
}
