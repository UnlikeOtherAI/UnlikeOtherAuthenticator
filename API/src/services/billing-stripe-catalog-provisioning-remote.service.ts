import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { CatalogDriftError, type CatalogDriftDetails } from './billing-stripe-catalog-provisioning-local.shared.js';
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

function remoteDrift(check: string, details: CatalogDriftDetails = {}): never {
  throw new CatalogDriftError('STRIPE_COMMERCIAL_CATALOG_DRIFT', check, details);
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
  // Stripe accepts at most ten lookup keys per list request.
  const pages = [];
  for (let index = 0; index < lookupKeys.length; index += 10) {
    const chunk = lookupKeys.slice(index, index + 10);
    const response = await stripe.prices.list({ lookup_keys: chunk, limit: 100 });
    if (response.has_more || response.data.length !== chunk.length) {
      remoteDrift('stripe_prices_by_lookup_key', { asked: chunk,
        found: response.data.map((price) => price.lookup_key ?? price.id) });
    }
    pages.push(...response.data);
  }

  const prices = new Map<string, Stripe.Price>();
  for (const price of pages) {
    if (
      !price.lookup_key ||
      !lookupKeys.includes(price.lookup_key) ||
      prices.has(price.lookup_key)
    ) {
      remoteDrift('stripe_price_lookup_key', { price_id: price.id, lookup_key: price.lookup_key ?? null });
    }
    prices.set(price.lookup_key, price);
  }
  const missing = lookupKeys.filter((key) => !prices.has(key));
  if (missing.length > 0) remoteDrift('stripe_prices_missing', { lookup_keys: missing });
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
    if (!activeProduct(product)) remoteDrift('stripe_product_inactive', { product_id: product.id });
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
  const fields = [
    !price.active && 'active',
    price.lookup_key !== spec.stripeLookupKey && 'lookup_key',
    price.currency !== spec.currency.toLowerCase() && 'currency',
    (price.type !== 'one_time' || price.recurring !== null) && 'type',
    (price.unit_amount !== Number(spec.paymentAmountMinor) ||
      price.unit_amount_decimal?.toString() !== spec.paymentAmountMinor.toString()) && 'unit_amount',
    stripeExternalId(price.product) !== product.id && 'product',
    !exactMetadata(price.metadata, creditPriceMetadata(spec)) && 'price_metadata',
    !exactMetadata(product.metadata, CREDIT_PRODUCT_METADATA) && 'product_metadata',
  ].filter((field): field is string => Boolean(field));
  if (fields.length > 0) {
    remoteDrift('stripe_credit_price_terms', { price_id: price.id, lookup_key: spec.stripeLookupKey, fields });
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
    remoteDrift('stripe_recurring_addon_price_terms', { price_id: price.id, product_id: product.id });
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
    if (!price || !product) remoteDrift('stripe_credit_price_missing', { lookup_key: spec.stripeLookupKey });
    return validateCreditPrice({
      price,
      product,
      expectedLivemode: params.expectedLivemode,
      spec,
    });
  });
  const creditProducts = [...new Set(creditPrices.map((price) => price.stripeProductId))];
  if (creditProducts.length !== 1) remoteDrift('stripe_credit_products_not_shared', { product_ids: creditProducts });

  const addonPrice = prices.get(DEEPWATER_PRIVACY_SPEC.stripeLookupKey);
  const addonProduct = addonPrice ? products.get(stripeExternalId(addonPrice.product)) : undefined;
  if (!addonPrice || !addonProduct) {
    remoteDrift('stripe_recurring_addon_price_missing', { lookup_key: DEEPWATER_PRIVACY_SPEC.stripeLookupKey });
  }
  const recurringAddon = validateRecurringAddon({
    price: addonPrice,
    product: addonProduct,
    expectedLivemode: params.expectedLivemode,
  });
  if (recurringAddon.stripeProductId === creditPrices[0]?.stripeProductId) {
    remoteDrift('stripe_recurring_addon_shares_credit_product', { product_id: recurringAddon.stripeProductId });
  }

  return {
    stripeAccountId: account.id,
    livemode: params.expectedLivemode,
    creditPrices,
    recurringAddon,
  };
}
