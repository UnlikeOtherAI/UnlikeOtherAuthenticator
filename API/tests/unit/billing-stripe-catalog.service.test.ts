import { describe, expect, it, vi } from 'vitest';

import {
  ensureStripeCatalog,
  ensureStripeTariffPrice,
  STRIPE_RATED_MINOR_UNIT_PRICE,
  STRIPE_RATED_MINOR_UNIT_SCALE,
} from '../../src/services/billing-stripe-catalog.service.js';

const account = {
  id: 'stripe_account_test',
  stripeAccountId: 'acct_uoa',
  livemode: false,
};

describe('Stripe tariff catalog', () => {
  it('creates a currency-specific sum meter without relabeling provider usage', async () => {
    let catalog = {
      id: 'catalog_1',
      accountId: account.id,
      serviceId: 'service_1',
      currency: 'GBP',
      meterEventName: 'uoa_rated_hash',
      stripeProductId: null as string | null,
      stripeMeterId: null as string | null,
      stripeUsagePriceId: null as string | null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = {
      billingStripeCatalog: {
        upsert: vi.fn().mockResolvedValue(catalog),
        update: vi.fn().mockImplementation(({ data }) => {
          catalog = { ...catalog, ...data };
          return catalog;
        }),
      },
      billingStripeTariffPrice: {},
    };
    const productsCreate = vi.fn().mockResolvedValue({ id: 'prod_1', livemode: false });
    const metersCreate = vi.fn().mockResolvedValue({ id: 'mtr_1', livemode: false });
    const pricesCreate = vi.fn().mockResolvedValue({
      id: 'price_usage_1',
      livemode: false,
    });
    const stripe = {
      products: { create: productsCreate },
      billing: { meters: { create: metersCreate } },
      prices: { create: pricesCreate },
    };

    const result = await ensureStripeCatalog(
      {
        service: { id: 'service_1', identifier: 'deepwater', name: 'DeepWater' },
        currency: 'GBP',
        account,
        stripe: stripe as never,
      },
      { prisma: prisma as never },
    );

    expect(result).toMatchObject({
      stripeProductId: 'prod_1',
      stripeMeterId: 'mtr_1',
      stripeUsagePriceId: 'price_usage_1',
    });
    expect(prisma.billingStripeCatalog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId_serviceId_currency: {
            accountId: account.id,
            serviceId: 'service_1',
            currency: 'GBP',
          },
        },
      }),
    );
    expect(productsCreate.mock.calls[0]?.[1].idempotencyKey).toContain(
      'acct_uoa:test:catalog-product:',
    );
    expect(metersCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: 'uoa_rated_hash',
        default_aggregation: { formula: 'sum' },
        value_settings: { event_payload_key: 'value' },
      }),
      expect.any(Object),
    );
    const priceInput = pricesCreate.mock.calls[0]?.[0];
    expect(priceInput.currency).toBe('gbp');
    expect(priceInput.unit_amount_decimal.toString()).toBe(STRIPE_RATED_MINOR_UNIT_PRICE);
    expect(priceInput.recurring).toEqual({
      interval: 'month',
      usage_type: 'metered',
      meter: 'mtr_1',
    });
    expect(priceInput.metadata).toMatchObject({
      uoa_rated_unit: 'minor_currency_unit_1e-6',
    });
    expect(STRIPE_RATED_MINOR_UNIT_SCALE).toBe(1_000_000n);
  });

  it('maps the exact immutable tariff version to an optional monthly price', async () => {
    let mapping = {
      id: 'mapping_1',
      accountId: account.id,
      tariffId: 'tariff_1',
      catalogId: 'catalog_1',
      monthlyAmountMinor: 2000n,
      stripeMonthlyPriceId: null as string | null,
      createdAt: new Date(),
    };
    const prisma = {
      billingStripeCatalog: {},
      billingStripeTariffPrice: {
        upsert: vi.fn().mockResolvedValue(mapping),
        update: vi.fn().mockImplementation(({ data }) => {
          mapping = { ...mapping, ...data };
          return mapping;
        }),
      },
    };
    const pricesCreate = vi.fn().mockResolvedValue({
      id: 'price_monthly_1',
      livemode: false,
    });

    const result = await ensureStripeTariffPrice(
      {
        tariff: {
          id: 'tariff_1',
          key: 'standard',
          version: 3,
          monthlyAmountMinor: 2000n,
        },
        catalog: {
          id: 'catalog_1',
          accountId: account.id,
          serviceId: 'service_1',
          currency: 'GBP',
          meterEventName: 'uoa_rated_hash',
          stripeProductId: 'prod_1',
          stripeMeterId: 'mtr_1',
          stripeUsagePriceId: 'price_usage_1',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        account,
        stripe: { prices: { create: pricesCreate } } as never,
      },
      { prisma: prisma as never },
    );

    expect(result.stripeMonthlyPriceId).toBe('price_monthly_1');
    const priceInput = pricesCreate.mock.calls[0]?.[0];
    expect(priceInput.unit_amount_decimal.toString()).toBe('2000');
    expect(priceInput.metadata).toMatchObject({
      uoa_tariff_id: 'tariff_1',
      uoa_tariff_version: '3',
    });
  });

  it('rejects a fixed Stripe Price on a zero-monthly tariff', async () => {
    const mapping = {
      id: 'mapping_zero',
      accountId: account.id,
      tariffId: 'tariff_zero',
      catalogId: 'catalog_1',
      monthlyAmountMinor: 0n,
      stripeMonthlyPriceId: 'price_unexpected',
      createdAt: new Date(),
    };
    const retrieve = vi.fn();

    await expect(
      ensureStripeTariffPrice(
        {
          tariff: {
            id: 'tariff_zero',
            key: 'at-cost',
            version: 1,
            monthlyAmountMinor: 0n,
          },
          catalog: {
            id: 'catalog_1',
            accountId: account.id,
            serviceId: 'service_1',
            currency: 'GBP',
            meterEventName: 'uoa_rated_hash',
            stripeProductId: 'prod_1',
            stripeMeterId: 'mtr_1',
            stripeUsagePriceId: 'price_usage_1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          account,
          stripe: { prices: { retrieve } } as never,
        },
        {
          prisma: {
            billingStripeCatalog: {},
            billingStripeTariffPrice: {
              upsert: vi.fn().mockResolvedValue(mapping),
            },
          } as never,
        },
      ),
    ).rejects.toThrow('STRIPE_TARIFF_PRICE_MISMATCH');
    expect(retrieve).not.toHaveBeenCalled();
  });
});
