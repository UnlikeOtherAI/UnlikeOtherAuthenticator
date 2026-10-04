import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  normalizeTariffInput,
  setDefaultBillingTariff,
} from '../../src/services/billing-tariff.service.js';

describe('billing tariff validation', () => {
  it('defaults omitted standard markup centrally while preserving explicit terms', () => {
    const base = {
      key: 'standard', name: 'Standard', mode: 'standard' as const,
      collectionMode: 'none' as const, monthlyAmountMinor: '0', currency: 'USD',
    };
    expect(normalizeTariffInput(base).markupBps).toBe(3000);
    expect(normalizeTariffInput({ ...base, markupBps: 1250 }).markupBps).toBe(1250);
    expect(normalizeTariffInput({ ...base, mode: 'at_cost' }).markupBps).toBe(0);
    expect(normalizeTariffInput({ ...base, mode: 'free' }).markupBps).toBe(0);
  });
  it('stores explicit markup and exact monthly minor units', () => {
    expect(
      normalizeTariffInput({
        key: 'Standard',
        name: 'Standard',
        mode: 'standard',
        collectionMode: 'stripe',
        markupBps: 4_000,
        monthlyAmountMinor: '2000',
        currency: 'usd',
      }),
    ).toMatchObject({
      key: 'standard',
      mode: 'STANDARD',
      collectionMode: 'STRIPE',
      markupBps: 4_000,
      monthlyAmountMinor: 2000n,
      currency: 'USD',
    });
  });

  it('keeps omitted legacy terms flat and PAYG while accepting explicit prepaid seat plans', () => {
    const base = {
      key: 'standard', name: 'Standard', mode: 'standard' as const,
      collectionMode: 'stripe' as const, monthlyAmountMinor: '2500', currency: 'USD',
    };
    expect(normalizeTariffInput(base)).toMatchObject({
      monthlyChargeBasis: 'FLAT', usagePaymentMode: 'PAY_AS_YOU_GO', markupBps: 3000,
    });
    expect(normalizeTariffInput({ ...base, monthlyChargeBasis: 'per_seat',
      usagePaymentMode: 'prepaid' })).toMatchObject({
      monthlyChargeBasis: 'PER_SEAT', usagePaymentMode: 'PREPAID',
      monthlyAmountMinor: 2500n,
    });
    expect(() => normalizeTariffInput({ ...base, usagePaymentMode: 'invalid' as never }))
      .toThrowError('INVALID_USAGE_PAYMENT_MODE');
  });

  it('requires free tariffs to have no usage markup or subscription', () => {
    expect(() =>
      normalizeTariffInput({
        key: 'free',
        name: 'Free',
        mode: 'free',
        collectionMode: 'none',
        markupBps: 100,
        monthlyAmountMinor: '0',
        currency: 'USD',
      }),
    ).toThrowError('INVALID_TARIFF_MODE_VALUES');
    expect(() =>
      normalizeTariffInput({
        key: 'free',
        name: 'Free',
        mode: 'free',
        collectionMode: 'none',
        markupBps: 0,
        monthlyAmountMinor: '1',
        currency: 'USD',
      }),
    ).toThrowError('INVALID_TARIFF_MODE_VALUES');
    expect(() =>
      normalizeTariffInput({
        key: 'free',
        name: 'Free',
        mode: 'free',
        collectionMode: 'stripe',
        markupBps: 0,
        monthlyAmountMinor: '0',
        currency: 'USD',
      }),
    ).toThrowError('INVALID_TARIFF_MODE_VALUES');
  });

  it('keeps at-cost usage visible at zero markup without requiring payment collection', () => {
    expect(
      normalizeTariffInput({
        key: 'at-cost',
        name: 'At cost',
        mode: 'at_cost',
        collectionMode: 'none',
        markupBps: 0,
        monthlyAmountMinor: '0',
        currency: 'EUR',
      }),
    ).toMatchObject({
      mode: 'AT_COST',
      collectionMode: 'NONE',
      markupBps: 0,
      monthlyAmountMinor: 0n,
    });
  });

  it('rejects fractional, negative, and out-of-range money values', () => {
    for (const monthlyAmountMinor of ['1.5', '-1', '9223372036854775808']) {
      expect(() =>
        normalizeTariffInput({
          key: 'standard',
          name: 'Standard',
          mode: 'standard',
          collectionMode: 'manual',
          markupBps: 2_000,
          monthlyAmountMinor,
          currency: 'USD',
        }),
      ).toThrowError('INVALID_MONTHLY_AMOUNT');
    }
  });

  it('retries a concurrent default update in a serializable transaction', async () => {
    const tariff = { id: 'tariff_2', serviceId: 'service_1', isDefault: false };
    const transactionClient = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'service_1' }]),
      billingTariffTermEvent: { create: vi.fn().mockResolvedValue({}) },
      billingTariff: {
        findFirst: vi.fn().mockResolvedValue(tariff),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({ ...tariff, isDefault: true }),
      },
      billingStripeCheckoutSession: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      billingStripeSubscription: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      adminAuditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
    };
    let attempts = 0;
    const transaction = vi.fn(
      async (
        run: (tx: typeof transactionClient) => Promise<unknown>,
        options: { isolationLevel: Prisma.TransactionIsolationLevel },
      ) => {
        attempts += 1;
        expect(options.isolationLevel).toBe(Prisma.TransactionIsolationLevel.Serializable);
        if (attempts === 1) throw { code: 'P2034' };
        return await run(transactionClient);
      },
    );

    const result = await setDefaultBillingTariff(
      {
        serviceId: 'service_1',
        tariffId: 'tariff_2',
        actor: { userId: 'admin_1', email: 'admin@example.com' },
      },
      { prisma: { $transaction: transaction } as never },
    );

    expect(result).toMatchObject({ id: 'tariff_2', isDefault: true });
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
