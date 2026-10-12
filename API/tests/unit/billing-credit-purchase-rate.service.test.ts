import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  STRIPE_FX_QUOTES_API_VERSION,
  creditsForPayment,
  readCreditPurchaseRate,
  readCreditPurchaseRateWithAlert,
} from '../../src/services/billing-credit-purchase-rate.service.js';

const now = new Date('2026-10-12T12:00:00.000Z');

function quote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fxq_1SAMPLE', object: 'fx_quote', lock_duration: 'none', to_currency: 'usd', created: 1_791_806_400,
    rates: { eur: { exchange_rate: 1.13844, rate_details: { base_rate: 1.16123 } } },
    ...overrides,
  };
}

function stripeReturning(value: unknown) {
  return { rawRequest: vi.fn().mockResolvedValue(value) };
}

afterEach(() => {
  delete process.env.BILLING_CREDIT_FX_RATE_SOURCE;
});

describe('credit purchase rate', () => {
  it('reads Stripe\'s live base rate with no lock and keeps the fee-bearing rate as evidence', async () => {
    const stripe = stripeReturning(quote());

    const rate = await readCreditPurchaseRate('EUR', { stripe: stripe as never, now: () => now });

    expect(stripe.rawRequest).toHaveBeenCalledWith('POST', '/v1/fx_quotes',
      { to_currency: 'usd', from_currencies: ['eur'], lock_duration: 'none' },
      { apiVersion: STRIPE_FX_QUOTES_API_VERSION });
    expect(rate).toEqual({ currency: 'EUR', source: 'stripe', baseRate: '1.16123', exchangeRate: '1.13844',
      quoteId: 'fxq_1SAMPLE', fxSnapshotId: null, asOf: new Date(1_791_806_400_000) });
  });

  it('sells USD at one to one without any rate read', async () => {
    const stripe = stripeReturning(quote());
    const rate = await readCreditPurchaseRate('USD', { stripe: stripe as never, now: () => now });
    expect(rate).toMatchObject({ currency: 'USD', source: 'usd', baseRate: '1', quoteId: null });
    expect(stripe.rawRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['a refused request', { rawRequest: vi.fn().mockRejectedValue(new Error('fx_quotes not enabled')) }],
    ['a locked quote', stripeReturning(quote({ lock_duration: 'five_minutes' }))],
    ['another target currency', stripeReturning(quote({ to_currency: 'eur' }))],
    ['a missing currency', stripeReturning(quote({ rates: { gbp: { exchange_rate: 1.3,
      rate_details: { base_rate: 1.33 } } } }))],
    ['a malformed quote id', stripeReturning(quote({ id: 'quote_1' }))],
  ])('refuses on %s and never falls back to ECB', async (_label, stripe) => {
    const prisma = { billingSmsFxSnapshot: { findFirst: vi.fn() } };
    await expect(readCreditPurchaseRate('EUR', { stripe: stripe as never, prisma: prisma as never, now: () => now }))
      .rejects.toMatchObject({ message: 'BILLING_CREDIT_FX_RATE_UNAVAILABLE', statusCode: 503 });
    expect(prisma.billingSmsFxSnapshot.findFirst).not.toHaveBeenCalled();
  });

  it('uses the accepted ECB snapshot only when the deployment selects it', async () => {
    process.env.BILLING_CREDIT_FX_RATE_SOURCE = 'ecb';
    const stripe = stripeReturning(quote());
    const findFirst = vi.fn().mockResolvedValue({ id: 'fx_snapshot_1', usdPerEur: new Prisma.Decimal('1.1612'),
      gbpPerEur: new Prisma.Decimal('0.8721'), rateDate: new Date('2026-10-09T00:00:00.000Z') });
    const prisma = { billingSmsFxSnapshot: { findFirst } };

    const eur = await readCreditPurchaseRate('EUR', { stripe: stripe as never, prisma: prisma as never, now: () => now });
    const gbp = await readCreditPurchaseRate('GBP', { stripe: stripe as never, prisma: prisma as never, now: () => now });

    expect(stripe.rawRequest).not.toHaveBeenCalled();
    expect(eur).toMatchObject({ source: 'ecb', baseRate: '1.1612', fxSnapshotId: 'fx_snapshot_1',
      quoteId: null, exchangeRate: null });
    // USD per GBP = (USD per EUR) / (GBP per EUR), rounded down to 12 places.
    expect(gbp.baseRate).toBe('1.331498681343');
    expect(findFirst.mock.calls[1]![0].where).toMatchObject({ gbpPerEur: { not: null }, expiresAt: { gt: now } });
  });

  it('refuses under ECB when no current snapshot exists', async () => {
    process.env.BILLING_CREDIT_FX_RATE_SOURCE = 'ecb';
    const prisma = { billingSmsFxSnapshot: { findFirst: vi.fn().mockResolvedValue(null) } };
    await expect(readCreditPurchaseRate('GBP', { stripe: stripeReturning(quote()) as never, prisma: prisma as never }))
      .rejects.toMatchObject({ message: 'BILLING_CREDIT_FX_RATE_UNAVAILABLE' });
  });

  it.each([
    [2_000n, '1.16123', 23_224_000_000n],
    [100_000n, '1.16123', 1_161_230_000_000n],
    [1_000n, '1.3314986813', 13_314_000_000n],
    [1n, '0.5', 0n],
  ])('grants %s minor at %s as %s microcredits, in whole credits', (minor, rate, expected) => {
    expect(creditsForPayment(minor, rate)).toBe(expected);
  });
});

describe('credit purchase rate alert', () => {
  function alertDb() {
    return {
      billingSmsFxSnapshot: { findFirst: vi.fn() },
      billingSmsPolicyAlert: {
        create: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
  }

  it('opens one credit_fx_rate_unavailable alert and refuses', async () => {
    const prisma = alertDb();
    const log = { error: vi.fn() };
    const stripe = { rawRequest: vi.fn().mockRejectedValue(new Error('down')) };

    await expect(readCreditPurchaseRateWithAlert('GBP', { stripe: stripe as never, prisma: prisma as never,
      now: () => now, log })).rejects.toMatchObject({ message: 'BILLING_CREDIT_FX_RATE_UNAVAILABLE' });

    expect(prisma.billingSmsPolicyAlert.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      kind: 'credit_fx_rate_unavailable', subject: 'credit-purchase:stripe:GBP',
      message: expect.stringContaining('BILLING_CREDIT_FX_RATE_SOURCE=ecb'), openedAt: now, lastSeenAt: now }) });
  });

  it('refreshes an already open alert instead of opening another', async () => {
    const prisma = alertDb();
    prisma.billingSmsPolicyAlert.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const stripe = { rawRequest: vi.fn().mockRejectedValue(new Error('down')) };

    await expect(readCreditPurchaseRateWithAlert('EUR', { stripe: stripe as never, prisma: prisma as never,
      now: () => now })).rejects.toMatchObject({ message: 'BILLING_CREDIT_FX_RATE_UNAVAILABLE' });

    expect(prisma.billingSmsPolicyAlert.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { kind: 'credit_fx_rate_unavailable', subject: 'credit-purchase:stripe:EUR', resolvedAt: null } }));
  });

  it('closes the currency\'s alert once a rate is read again', async () => {
    const prisma = alertDb();

    await readCreditPurchaseRateWithAlert('EUR', { stripe: stripeReturning(quote()) as never,
      prisma: prisma as never, now: () => now });

    expect(prisma.billingSmsPolicyAlert.create).not.toHaveBeenCalled();
    expect(prisma.billingSmsPolicyAlert.updateMany).toHaveBeenCalledWith({
      where: { subject: 'credit-purchase:stripe:EUR', resolvedAt: null }, data: { resolvedAt: now } });
  });
});
