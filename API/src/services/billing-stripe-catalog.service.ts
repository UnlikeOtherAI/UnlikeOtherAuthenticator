import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

export const STRIPE_RATED_MINOR_UNIT_SCALE = 1_000_000n;
export const STRIPE_RATED_MINOR_UNIT_PRICE = '0.000001';

type CatalogPrisma = Pick<
  PrismaClient,
  'billingStripeCatalog' | 'billingStripeTariffPrice'
>;

type StripeCatalogClient = Pick<Stripe, 'products' | 'prices' | 'billing'>;

function client(deps?: { prisma?: CatalogPrisma }): CatalogPrisma {
  return deps?.prisma ?? getAdminPrisma();
}

function meterEventName(serviceId: string, currency: string): string {
  const digest = createHash('sha256')
    .update(`${serviceId}\0${currency}`)
    .digest('hex');
  return `uoa_rated_${digest}`;
}

function idempotencyKey(kind: string, id: string): string {
  return `uoa:${kind}:${id}`;
}

export async function ensureStripeCatalog(
  params: {
    service: { id: string; identifier: string; name: string };
    currency: string;
    stripe: StripeCatalogClient;
  },
  deps?: { prisma?: CatalogPrisma },
) {
  const prisma = client(deps);
  let catalog = await prisma.billingStripeCatalog.upsert({
    where: {
      serviceId_currency: {
        serviceId: params.service.id,
        currency: params.currency,
      },
    },
    create: {
      serviceId: params.service.id,
      currency: params.currency,
      meterEventName: meterEventName(params.service.id, params.currency),
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
        },
      },
      { idempotencyKey: idempotencyKey('catalog-product', catalog.id) },
    );
    catalog = await prisma.billingStripeCatalog.update({
      where: { id: catalog.id },
      data: { stripeProductId: product.id },
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
      { idempotencyKey: idempotencyKey('catalog-meter', catalog.id) },
    );
    catalog = await prisma.billingStripeCatalog.update({
      where: { id: catalog.id },
      data: { stripeMeterId: meter.id },
    });
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
        },
      },
      { idempotencyKey: idempotencyKey('catalog-usage-price', catalog.id) },
    );
    catalog = await prisma.billingStripeCatalog.update({
      where: { id: catalog.id },
      data: { stripeUsagePriceId: price.id },
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
    stripe: Pick<Stripe, 'prices'>;
  },
  deps?: { prisma?: CatalogPrisma },
) {
  const prisma = client(deps);
  let mapping = await prisma.billingStripeTariffPrice.upsert({
    where: { tariffId: params.tariff.id },
    create: {
      tariffId: params.tariff.id,
      catalogId: params.catalog.id,
      monthlyAmountMinor: params.tariff.monthlyAmountMinor,
    },
    update: {},
  });
  if (
    mapping.catalogId !== params.catalog.id ||
    mapping.monthlyAmountMinor !== params.tariff.monthlyAmountMinor
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
        },
      },
      { idempotencyKey: idempotencyKey('tariff-monthly-price', mapping.id) },
    );
    mapping = await prisma.billingStripeTariffPrice.update({
      where: { id: mapping.id },
      data: { stripeMonthlyPriceId: price.id },
    });
  }
  return mapping;
}
