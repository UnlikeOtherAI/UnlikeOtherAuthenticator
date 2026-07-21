import type {
  BillingRecurringAddonCatalog,
  BillingRecurringAddonOffer,
  PrismaClient,
} from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import {
  assertStripeObjectLivemode,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import {
  recurringAddonPriceMetadata,
  recurringAddonProductMetadata,
} from './billing-stripe-catalog-provisioning-spec.js';

export type RecurringAddonCatalogClient = Pick<Stripe, 'prices' | 'products'>;

function idempotencyKey(account: StripeAccountContext, kind: string, id: string): string {
  return `uoa:${account.stripeAccountId}:${account.livemode ? 'live' : 'test'}:${kind}:${id}`;
}

function externalId(value: string | { id: string } | null): string | null {
  return typeof value === 'string' ? value : (value?.id ?? null);
}

function productMetadata(
  offer: BillingRecurringAddonOffer,
  serviceIdentifier: string,
): Stripe.MetadataParam {
  return recurringAddonProductMetadata({
    serviceIdentifier,
    offerKey: offer.key,
    offerVersion: offer.version,
  });
}

function priceMetadata(
  offer: BillingRecurringAddonOffer,
  serviceIdentifier: string,
): Stripe.MetadataParam {
  return recurringAddonPriceMetadata({ serviceIdentifier, offerKey: offer.key });
}

function assertMetadata(actual: Stripe.Metadata, expected: Stripe.MetadataParam): void {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    Object.entries(expected).some(([key, value]) => actual[key] !== value)
  ) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_CATALOG_DRIFT');
  }
}

function assertTerms(
  catalog: BillingRecurringAddonCatalog,
  offer: BillingRecurringAddonOffer,
  account: StripeAccountContext,
): void {
  if (
    catalog.accountId !== account.id ||
    catalog.serviceId !== offer.serviceId ||
    catalog.offerId !== offer.id ||
    catalog.currency !== offer.currency ||
    catalog.monthlyAmountMinor !== offer.monthlyAmountMinor
  ) {
    throw new AppError('INTERNAL', 409, 'BILLING_RECURRING_ADDON_CATALOG_MISMATCH');
  }
}

async function validateRemoteCatalog(params: {
  catalog: BillingRecurringAddonCatalog;
  offer: BillingRecurringAddonOffer;
  serviceIdentifier: string;
  account: StripeAccountContext;
  stripe: RecurringAddonCatalogClient;
}): Promise<void> {
  const { catalog, offer, account, stripe } = params;
  if (!catalog.stripeProductId || !catalog.stripePriceId) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_CATALOG_INCOMPLETE');
  }
  const [product, price] = await Promise.all([
    stripe.products.retrieve(catalog.stripeProductId),
    stripe.prices.retrieve(catalog.stripePriceId),
  ]);
  assertStripeObjectLivemode(product, account.livemode);
  assertStripeObjectLivemode(price, account.livemode);
  if (
    product.deleted ||
    !product.active ||
    !price.active ||
    externalId(price.product) !== product.id ||
    price.lookup_key !== catalog.stripeLookupKey ||
    price.currency !== catalog.currency.toLowerCase() ||
    price.type !== 'recurring' ||
    price.unit_amount !== Number(catalog.monthlyAmountMinor) ||
    price.unit_amount_decimal?.toString() !== catalog.monthlyAmountMinor.toString() ||
    price.recurring?.interval !== 'month' ||
    price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== 'licensed' ||
    price.recurring.meter !== null
  ) {
    throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_CATALOG_DRIFT');
  }
  assertMetadata(product.metadata, productMetadata(offer, params.serviceIdentifier));
  assertMetadata(price.metadata, priceMetadata(offer, params.serviceIdentifier));
}

export async function ensureRecurringAddonStripeCatalog(
  params: {
    catalog: BillingRecurringAddonCatalog;
    offer: BillingRecurringAddonOffer;
    serviceIdentifier: string;
    serviceName: string;
    account: StripeAccountContext;
    stripe: RecurringAddonCatalogClient;
  },
  deps: { prisma: Pick<PrismaClient, 'billingRecurringAddonCatalog'> },
): Promise<BillingRecurringAddonCatalog> {
  assertTerms(params.catalog, params.offer, params.account);
  if (params.catalog.stripeProductId || params.catalog.stripePriceId) {
    await validateRemoteCatalog(params);
    return params.catalog;
  }

  const product = await params.stripe.products.create(
    {
      name: `${params.serviceName} — ${params.offer.name}`,
      description: params.offer.description,
      metadata: productMetadata(params.offer, params.serviceIdentifier),
    },
    {
      idempotencyKey: idempotencyKey(params.account, 'recurring-addon-product', params.catalog.id),
    },
  );
  assertStripeObjectLivemode(product, params.account.livemode);
  const price = await params.stripe.prices.create(
    {
      product: product.id,
      currency: params.catalog.currency.toLowerCase(),
      unit_amount: Number(params.catalog.monthlyAmountMinor),
      recurring: { interval: 'month', usage_type: 'licensed' },
      lookup_key: params.catalog.stripeLookupKey,
      nickname: `${params.offer.key} v${params.offer.version} monthly`,
      metadata: priceMetadata(params.offer, params.serviceIdentifier),
    },
    {
      idempotencyKey: idempotencyKey(params.account, 'recurring-addon-price', params.catalog.id),
    },
  );
  assertStripeObjectLivemode(price, params.account.livemode);
  let catalog: BillingRecurringAddonCatalog;
  try {
    catalog = await deps.prisma.billingRecurringAddonCatalog.update({
      where: { id: params.catalog.id },
      data: { stripeProductId: product.id, stripePriceId: price.id },
    });
  } catch (error) {
    catalog = await deps.prisma.billingRecurringAddonCatalog.findUniqueOrThrow({
      where: { id: params.catalog.id },
    });
    if (catalog.stripeProductId !== product.id || catalog.stripePriceId !== price.id) throw error;
  }
  await validateRemoteCatalog({ ...params, catalog });
  return catalog;
}
