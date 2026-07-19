import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  assertStripeObjectLivemode,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';

export const STRIPE_RATED_MINOR_UNIT_SCALE = 1_000_000n;
export const STRIPE_RATED_MINOR_UNIT_PRICE = '0.000001';

type CatalogPrisma = Pick<PrismaClient, 'billingStripeCatalog' | 'billingStripeTariffPrice'>;

type StripeCatalogClient = Pick<Stripe, 'products' | 'prices' | 'billing'>;

function client(deps?: { prisma?: CatalogPrisma }): CatalogPrisma {
  return deps?.prisma ?? getAdminPrisma();
}

function meterEventName(
  account: StripeAccountContext,
  serviceId: string,
  currency: string,
): string {
  const digest = createHash('sha256')
    .update(
      `${account.stripeAccountId}\0${account.livemode ? 'live' : 'test'}\0${serviceId}\0${currency}`,
    )
    .digest('hex');
  return `uoa_rated_${digest}`;
}

function idempotencyKey(account: StripeAccountContext, kind: string, id: string): string {
  return `uoa:${account.stripeAccountId}:${account.livemode ? 'live' : 'test'}:${kind}:${id}`;
}

function externalId(value: string | { id: string } | null): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function assertMetadata(metadata: Stripe.Metadata, expected: Record<string, string>): void {
  if (Object.entries(expected).some(([key, value]) => metadata[key] !== value)) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CATALOG_BINDING_INVALID');
  }
}

export async function ensureStripeCatalog(
  params: {
    service: { id: string; identifier: string; name: string };
    currency: string;
    account: StripeAccountContext;
    stripe: StripeCatalogClient;
  },
  deps?: { prisma?: CatalogPrisma },
) {
  const prisma = client(deps);
  let catalog = await prisma.billingStripeCatalog.upsert({
    where: {
      accountId_serviceId_currency: {
        accountId: params.account.id,
        serviceId: params.service.id,
        currency: params.currency,
      },
    },
    create: {
      accountId: params.account.id,
      serviceId: params.service.id,
      currency: params.currency,
      meterEventName: meterEventName(params.account, params.service.id, params.currency),
    },
    update: {},
  });

  if (!catalog.stripeProductId) {
    const product = await params.stripe.products.create(
      {
        name: `${params.service.name} usage`,
        metadata: {
          uoa_service_id: params.service.id,
          uoa_product: params.service.identifier,
          uoa_stripe_account_id: params.account.stripeAccountId,
          uoa_stripe_mode: params.account.livemode ? 'live' : 'test',
        },
      },
      {
        idempotencyKey: idempotencyKey(params.account, 'catalog-product', catalog.id),
      },
    );
    assertStripeObjectLivemode(product, params.account.livemode);
    catalog = await prisma.billingStripeCatalog.update({
      where: { id: catalog.id },
      data: { stripeProductId: product.id },
    });
  } else {
    const product = await params.stripe.products.retrieve(catalog.stripeProductId);
    assertStripeObjectLivemode(product, params.account.livemode);
    assertMetadata(product.metadata, {
      uoa_service_id: params.service.id,
      uoa_product: params.service.identifier,
      uoa_stripe_account_id: params.account.stripeAccountId,
      uoa_stripe_mode: params.account.livemode ? 'live' : 'test',
    });
  }

  if (!catalog.stripeMeterId) {
    const meter = await params.stripe.billing.meters.create(
      {
        display_name: `${params.service.name} rated usage (${params.currency})`,
        event_name: catalog.meterEventName,
        default_aggregation: { formula: 'sum' },
        customer_mapping: {
          type: 'by_id',
          event_payload_key: 'stripe_customer_id',
        },
        value_settings: { event_payload_key: 'value' },
      },
      {
        idempotencyKey: idempotencyKey(params.account, 'catalog-meter', catalog.id),
      },
    );
    assertStripeObjectLivemode(meter, params.account.livemode);
    catalog = await prisma.billingStripeCatalog.update({
      where: { id: catalog.id },
      data: { stripeMeterId: meter.id },
    });
  } else {
    const meter = await params.stripe.billing.meters.retrieve(catalog.stripeMeterId);
    assertStripeObjectLivemode(meter, params.account.livemode);
    if (
      meter.event_name !== catalog.meterEventName ||
      meter.default_aggregation.formula !== 'sum'
    ) {
      throw new AppError('INTERNAL', 502, 'STRIPE_CATALOG_BINDING_INVALID');
    }
  }

  if (!catalog.stripeUsagePriceId) {
    if (!catalog.stripeProductId || !catalog.stripeMeterId) {
      throw new AppError('INTERNAL', 500, 'STRIPE_CATALOG_INCOMPLETE');
    }
    const price = await params.stripe.prices.create(
      {
        product: catalog.stripeProductId,
        currency: params.currency.toLowerCase(),
        unit_amount_decimal: Stripe.Decimal.from(STRIPE_RATED_MINOR_UNIT_PRICE),
        recurring: {
          interval: 'month',
          usage_type: 'metered',
          meter: catalog.stripeMeterId,
        },
        nickname: `${params.service.name} rated usage`,
        metadata: {
          uoa_service_id: params.service.id,
          uoa_product: params.service.identifier,
          uoa_rated_unit: 'minor_currency_unit_1e-6',
          uoa_stripe_account_id: params.account.stripeAccountId,
          uoa_stripe_mode: params.account.livemode ? 'live' : 'test',
        },
      },
      {
        idempotencyKey: idempotencyKey(params.account, 'catalog-usage-price', catalog.id),
      },
    );
    assertStripeObjectLivemode(price, params.account.livemode);
    catalog = await prisma.billingStripeCatalog.update({
      where: { id: catalog.id },
      data: { stripeUsagePriceId: price.id },
    });
  } else {
    const price = await params.stripe.prices.retrieve(catalog.stripeUsagePriceId);
    assertStripeObjectLivemode(price, params.account.livemode);
    if (
      externalId(price.product) !== catalog.stripeProductId ||
      price.currency !== params.currency.toLowerCase() ||
      price.recurring?.interval !== 'month' ||
      price.recurring.usage_type !== 'metered' ||
      externalId(price.recurring.meter) !== catalog.stripeMeterId
    ) {
      throw new AppError('INTERNAL', 502, 'STRIPE_CATALOG_BINDING_INVALID');
    }
    assertMetadata(price.metadata, {
      uoa_service_id: params.service.id,
      uoa_product: params.service.identifier,
      uoa_rated_unit: 'minor_currency_unit_1e-6',
      uoa_stripe_account_id: params.account.stripeAccountId,
      uoa_stripe_mode: params.account.livemode ? 'live' : 'test',
    });
  }
  return catalog;
}

export async function ensureStripeTariffPrice(
  params: {
    tariff: {
      id: string;
      key: string;
      version: number;
      monthlyAmountMinor: bigint;
    };
    catalog: Awaited<ReturnType<typeof ensureStripeCatalog>>;
    account: StripeAccountContext;
    stripe: Pick<Stripe, 'prices'>;
  },
  deps?: { prisma?: CatalogPrisma },
) {
  const prisma = client(deps);
  let mapping = await prisma.billingStripeTariffPrice.upsert({
    where: {
      accountId_tariffId: {
        accountId: params.account.id,
        tariffId: params.tariff.id,
      },
    },
    create: {
      accountId: params.account.id,
      tariffId: params.tariff.id,
      catalogId: params.catalog.id,
      monthlyAmountMinor: params.tariff.monthlyAmountMinor,
    },
    update: {},
  });
  if (
    mapping.catalogId !== params.catalog.id ||
    mapping.accountId !== params.account.id ||
    mapping.monthlyAmountMinor !== params.tariff.monthlyAmountMinor ||
    (params.tariff.monthlyAmountMinor === 0n && mapping.stripeMonthlyPriceId !== null)
  ) {
    throw new AppError('INTERNAL', 500, 'STRIPE_TARIFF_PRICE_MISMATCH');
  }

  if (params.tariff.monthlyAmountMinor > 0n && !mapping.stripeMonthlyPriceId) {
    if (!params.catalog.stripeProductId) {
      throw new AppError('INTERNAL', 500, 'STRIPE_CATALOG_INCOMPLETE');
    }
    const price = await params.stripe.prices.create(
      {
        product: params.catalog.stripeProductId,
        currency: params.catalog.currency.toLowerCase(),
        unit_amount_decimal: Stripe.Decimal.from(params.tariff.monthlyAmountMinor),
        recurring: { interval: 'month', usage_type: 'licensed' },
        nickname: `${params.tariff.key} v${params.tariff.version} monthly`,
        metadata: {
          uoa_tariff_id: params.tariff.id,
          uoa_tariff_key: params.tariff.key,
          uoa_tariff_version: params.tariff.version.toString(),
          uoa_stripe_account_id: params.account.stripeAccountId,
          uoa_stripe_mode: params.account.livemode ? 'live' : 'test',
        },
      },
      {
        idempotencyKey: idempotencyKey(params.account, 'tariff-monthly-price', mapping.id),
      },
    );
    assertStripeObjectLivemode(price, params.account.livemode);
    mapping = await prisma.billingStripeTariffPrice.update({
      where: { id: mapping.id },
      data: { stripeMonthlyPriceId: price.id },
    });
  } else if (mapping.stripeMonthlyPriceId) {
    const price = await params.stripe.prices.retrieve(mapping.stripeMonthlyPriceId);
    assertStripeObjectLivemode(price, params.account.livemode);
    if (
      externalId(price.product) !== params.catalog.stripeProductId ||
      price.currency !== params.catalog.currency.toLowerCase() ||
      price.unit_amount_decimal?.toString() !== params.tariff.monthlyAmountMinor.toString() ||
      price.recurring?.interval !== 'month' ||
      price.recurring.usage_type !== 'licensed'
    ) {
      throw new AppError('INTERNAL', 502, 'STRIPE_TARIFF_PRICE_BINDING_INVALID');
    }
    assertMetadata(price.metadata, {
      uoa_tariff_id: params.tariff.id,
      uoa_tariff_key: params.tariff.key,
      uoa_tariff_version: params.tariff.version.toString(),
      uoa_stripe_account_id: params.account.stripeAccountId,
      uoa_stripe_mode: params.account.livemode ? 'live' : 'test',
    });
  }
  return mapping;
}
