import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { assertStripeObjectLivemode } from './billing-stripe-client.service.js';
import {
  CREDIT_PRODUCT_METADATA,
  CREDIT_TOP_UP_SPECS,
  creditPriceMetadata,
  DEEPWATER_PRIVACY_SPEC,
  recurringAddonPriceMetadata,
  recurringAddonProductMetadata,
} from './billing-stripe-catalog-provisioning-spec.js';

export type StripeCatalogProvisioningClient = Pick<Stripe, 'accounts' | 'prices' | 'products'>;

export type ValidatedCreditPrice = {
  key: string;
  version: number;
  stripeLookupKey: string;
  stripeProductId: string;
  stripePriceId: string;
};

export type ValidatedStripeCommercialCatalog = {
  stripeAccountId: string;
  livemode: boolean;
  creditPrices: ValidatedCreditPrice[];
  recurringAddon: {
    stripeLookupKey: string;
    stripeProductId: string;
    stripePriceId: string;
  };
};

function remoteDrift(): never {
  throw new AppError('INTERNAL', 409, 'STRIPE_COMMERCIAL_CATALOG_DRIFT');
}

function exactMetadata(actual: Stripe.Metadata, expected: Record<string, string>): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key])
  );
}

function stripeExternalId(value: string | { id: string }): string {
  return typeof value === 'string' ? value : value.id;
}

function activeProduct(product: Stripe.Product | Stripe.DeletedProduct): product is Stripe.Product {
  return !('deleted' in product) && product.active;
}

async function loadPrices(
  stripe: StripeCatalogProvisioningClient,
): Promise<Map<string, Stripe.Price>> {
  const lookupKeys = [
    ...CREDIT_TOP_UP_SPECS.map((spec) => spec.stripeLookupKey),
    DEEPWATER_PRIVACY_SPEC.stripeLookupKey,
  ];
  const response = await stripe.prices.list({ lookup_keys: lookupKeys, limit: 100 });
  if (response.has_more || response.data.length !== lookupKeys.length) remoteDrift();

  const prices = new Map<string, Stripe.Price>();
  for (const price of response.data) {
    if (
      !price.lookup_key ||
      !lookupKeys.includes(price.lookup_key) ||
      prices.has(price.lookup_key)
    ) {
      remoteDrift();
    }
    prices.set(price.lookup_key, price);
  }
  if (lookupKeys.some((key) => !prices.has(key))) remoteDrift();
  return prices;
}

async function loadProducts(
  stripe: StripeCatalogProvisioningClient,
  prices: Map<string, Stripe.Price>,
): Promise<Map<string, Stripe.Product>> {
  const ids = [...new Set([...prices.values()].map((price) => stripeExternalId(price.product)))];
  const products = await Promise.all(ids.map((id) => stripe.products.retrieve(id)));
  const result = new Map<string, Stripe.Product>();
  for (const product of products) {
    if (!activeProduct(product)) remoteDrift();
    result.set(product.id, product);
  }
  return result;
}

function validateCreditPrice(params: {
  price: Stripe.Price;
  product: Stripe.Product;
  expectedLivemode: boolean;
  spec: (typeof CREDIT_TOP_UP_SPECS)[number];
}): ValidatedCreditPrice {
  const { price, product, expectedLivemode, spec } = params;
  assertStripeObjectLivemode(price, expectedLivemode);
  assertStripeObjectLivemode(product, expectedLivemode);
  if (
    !price.active ||
    price.lookup_key !== spec.stripeLookupKey ||
    price.currency !== 'usd' ||
    price.type !== 'one_time' ||
    price.recurring !== null ||
    price.unit_amount !== Number(spec.paymentAmountMinor) ||
    price.unit_amount_decimal?.toString() !== spec.paymentAmountMinor.toString() ||
    stripeExternalId(price.product) !== product.id ||
    !exactMetadata(price.metadata, creditPriceMetadata(spec)) ||
    !exactMetadata(product.metadata, CREDIT_PRODUCT_METADATA)
  ) {
    remoteDrift();
  }
  return {
    key: spec.catalogKey,
    version: spec.catalogVersion,
    stripeLookupKey: spec.stripeLookupKey,
    stripeProductId: product.id,
    stripePriceId: price.id,
  };
}

function validateRecurringAddon(params: {
  price: Stripe.Price;
  product: Stripe.Product;
  expectedLivemode: boolean;
}): ValidatedStripeCommercialCatalog['recurringAddon'] {
  const { price, product, expectedLivemode } = params;
  const metadataSubject = {
    serviceIdentifier: DEEPWATER_PRIVACY_SPEC.serviceIdentifier,
    offerKey: DEEPWATER_PRIVACY_SPEC.key,
  };
  assertStripeObjectLivemode(price, expectedLivemode);
  assertStripeObjectLivemode(product, expectedLivemode);
  if (
    !price.active ||
    price.lookup_key !== DEEPWATER_PRIVACY_SPEC.stripeLookupKey ||
    price.currency !== 'usd' ||
    price.type !== 'recurring' ||
    price.unit_amount !== Number(DEEPWATER_PRIVACY_SPEC.monthlyAmountMinor) ||
    price.unit_amount_decimal?.toString() !==
      DEEPWATER_PRIVACY_SPEC.monthlyAmountMinor.toString() ||
    price.recurring?.interval !== 'month' ||
    price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== 'licensed' ||
    price.recurring.meter !== null ||
    stripeExternalId(price.product) !== product.id ||
    !exactMetadata(price.metadata, recurringAddonPriceMetadata(metadataSubject)) ||
    !exactMetadata(
      product.metadata,
      recurringAddonProductMetadata({
        ...metadataSubject,
        offerVersion: DEEPWATER_PRIVACY_SPEC.version,
      }),
    )
  ) {
    remoteDrift();
  }
  return {
    stripeLookupKey: DEEPWATER_PRIVACY_SPEC.stripeLookupKey,
    stripeProductId: product.id,
    stripePriceId: price.id,
  };
}

export async function validateStripeCommercialCatalog(params: {
  stripe: StripeCatalogProvisioningClient;
  expectedStripeAccountId: string;
  expectedLivemode: boolean;
}): Promise<ValidatedStripeCommercialCatalog> {
  const account = await params.stripe.accounts.retrieveCurrent();
  if (account.id !== params.expectedStripeAccountId) {
    throw new AppError('INTERNAL', 409, 'STRIPE_COMMERCIAL_CATALOG_ACCOUNT_MISMATCH');
  }
  const prices = await loadPrices(params.stripe);
  const products = await loadProducts(params.stripe, prices);
  const creditPrices = CREDIT_TOP_UP_SPECS.map((spec) => {
    const price = prices.get(spec.stripeLookupKey);
    const product = price ? products.get(stripeExternalId(price.product)) : undefined;
    if (!price || !product) remoteDrift();
    return validateCreditPrice({
      price,
      product,
      expectedLivemode: params.expectedLivemode,
      spec,
    });
  });
  if (new Set(creditPrices.map((price) => price.stripeProductId)).size !== 1) remoteDrift();

  const addonPrice = prices.get(DEEPWATER_PRIVACY_SPEC.stripeLookupKey);
  const addonProduct = addonPrice ? products.get(stripeExternalId(addonPrice.product)) : undefined;
  if (!addonPrice || !addonProduct) remoteDrift();
  const recurringAddon = validateRecurringAddon({
    price: addonPrice,
    product: addonProduct,
    expectedLivemode: params.expectedLivemode,
  });
  if (recurringAddon.stripeProductId === creditPrices[0]?.stripeProductId) remoteDrift();

  return {
    stripeAccountId: account.id,
    livemode: params.expectedLivemode,
    creditPrices,
    recurringAddon,
  };
}
