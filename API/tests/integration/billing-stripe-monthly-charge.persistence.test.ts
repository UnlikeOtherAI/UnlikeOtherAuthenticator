import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { collectStripeMonthlyCharge } from '../../src/services/billing-stripe-monthly-charge.service.js';
import { createTestDb } from '../helpers/test-db.js';

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
const month = '2026-09';
const startsAt = new Date('2026-09-01T00:00:00.000Z');
const endsAt = new Date('2026-10-01T00:00:00.000Z');

describe.skipIf(!process.env.DATABASE_URL)('Stripe monthly seat charge source', () => {
  let db: TestDb;
  let subscriptionId: string;
  let accountId: string;
  let serviceId: string;
  let tariffId: string;
  let orgId: string;

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const owner = await db.prisma.user.create({ data: {
      email: `${randomUUID()}@example.test`, userKey: `${randomUUID()}@example.test`,
    } });
    const org = await db.prisma.organisation.create({ data: {
      ownerId: owner.id, domain: `${randomUUID()}.example.test`,
      slug: `monthly-${randomUUID().slice(0, 8)}`, name: 'Monthly seat customer',
    } });
    orgId = org.id;
    const service = await db.prisma.billingService.create({ data: {
      identifier: `monthly-${randomUUID()}`, name: 'Monthly service',
    } });
    serviceId = service.id;
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId, key: 'seat', version: 1, name: 'Seats',
      mode: 'STANDARD', collectionMode: 'STRIPE', markupBps: 3000,
      monthlyAmountMinor: 2500n, monthlyChargeBasis: 'PER_SEAT',
      seatPolicy: 'FIXED', seatChargeTiming: 'FULL_MONTH', currency: 'USD',
    } });
    tariffId = tariff.id;
    const appKey = await db.prisma.billingAppKey.create({ data: {
      serviceId, name: 'Monthly key', keyPrefix: `uoa_${randomUUID().slice(0, 12)}`,
      secretDigest: 'a'.repeat(64), actorIssuer: 'https://example.test',
      actorAudience: 'https://uoa.example.test', actorKeyId: 'monthly-key',
      actorPublicJwk: { kty: 'RSA', kid: 'monthly-key', n: 'AQAB', e: 'AQAB' },
    } });
    const account = await db.prisma.billingStripeAccount.create({ data: {
      stripeAccountId: `acct_${randomUUID()}`, livemode: false,
    } });
    accountId = account.id;
    const customer = await db.prisma.billingStripeCustomer.create({ data: {
      accountId, orgId, teamId: null, scope: 'ORGANISATION', scopeKey: orgId,
      stripeCustomerId: 'cus_monthly',
    } });
    const checkout = await db.prisma.billingStripeCheckoutSession.create({ data: {
      accountId, appKeyId: appKey.id, customerId: customer.id,
      serviceId, tariffId, tariffSource: 'SERVICE_DEFAULT',
      orgId, teamId: null, scope: 'ORGANISATION', scopeKey: orgId,
      actorJti: randomUUID(), requestedByUserId: owner.id,
      successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64),
      leaseExpiresAt: new Date('2026-10-02T00:00:00.000Z'),
    } });
    const subscription = await db.prisma.billingStripeSubscription.create({ data: {
      accountId, checkoutId: checkout.id, customerId: customer.id,
      serviceId, tariffId, tariffSource: 'SERVICE_DEFAULT',
      orgId, teamId: null, scope: 'ORGANISATION', scopeKey: orgId,
      stripeSubscriptionId: 'sub_monthly', stripeUsageItemId: 'si_metered',
      stripeMonthlyItemId: null, status: 'active', livemode: false,
      currentPeriodStart: endsAt,
      currentPeriodEnd: new Date('2026-11-01T00:00:00.000Z'),
    } });
    subscriptionId = subscription.id;
  });
  afterAll(async () => { if (db) await db.cleanup(); });

  function params(invoiceId: string) {
    return { subscriptionId, accountId, invoiceId, customerId: 'cus_monthly',
      livemode: false, billingMonth: month, periodStartsAt: startsAt,
      periodEndsAt: endsAt, currency: 'USD', stripeMonthlyItemId: null,
      monthlyLineObserved: false, closingCancellation: false };
  }

  function quote(amountMinor = 5000n) {
    return { source: { kind: 'stripe', id: subscriptionId },
      billingMonth: month, serviceId, tariffId, organisationId: orgId,
      teamId: null, scope: 'ORGANISATION', agreementId: 'seat-agreement',
      chargeBasis: 'PER_SEAT', seatPolicy: 'FIXED', seatChargeTiming: 'FULL_MONTH',
      amountMinor, unitAmountMinor: 2500n, currency: 'USD',
      commercialEffectiveAt: startsAt, commercialEndsAt: null,
      evidenceIds: ['seat-interval'], intervals: [], capacityRevisions: [],
    };
  }

  it('reconciles a lost Stripe acknowledgement to exactly one immutable invoice item', async () => {
    const remote: Array<Record<string, unknown>> = [];
    const stripe = { invoiceItems: {
      list: vi.fn().mockImplementation(async () => ({ data: remote, has_more: false })),
      create: vi.fn().mockImplementation(async (input: Record<string, unknown>) => {
        const item = { id: 'ii_monthly', object: 'invoiceitem', invoice: input.invoice,
          customer: input.customer, amount: input.amount, currency: input.currency,
          livemode: false, metadata: input.metadata, period: input.period };
        remote.push(item);
        throw new Error('provider accepted; response lost');
      }),
    } };
    const deps = { prisma: db.prisma, stripe: stripe as never,
      quote: vi.fn().mockResolvedValue(quote()),
      now: () => new Date('2026-10-01T01:00:00.000Z') };
    await expect(collectStripeMonthlyCharge(params('in_monthly'), deps))
      .rejects.toThrow('provider accepted; response lost');
    expect(await db.prisma.billingStripeMonthlyCharge.findUniqueOrThrow({
      where: { subscriptionId_billingMonth: { subscriptionId, billingMonth: month } },
    })).toMatchObject({ state: 'HELD', stripeInvoiceItemId: null });
    await collectStripeMonthlyCharge(params('in_monthly'), deps);
    expect(stripe.invoiceItems.create).toHaveBeenCalledOnce();
    expect(stripe.invoiceItems.create.mock.calls[0]?.[0]).toMatchObject({
      invoice: 'in_monthly', amount: 5000, currency: 'usd', discountable: false,
      period: { start: startsAt.getTime() / 1000, end: endsAt.getTime() / 1000 },
    });
    const source = await db.prisma.billingStripeMonthlyCharge.findUniqueOrThrow({
      where: { subscriptionId_billingMonth: { subscriptionId, billingMonth: month } },
    });
    expect(source).toMatchObject({ state: 'ACCEPTED', stripeInvoiceItemId: 'ii_monthly',
      amountMinor: 5000n, stripeInvoiceId: 'in_monthly' });
    await expect(collectStripeMonthlyCharge(params('in_other'), deps))
      .rejects.toThrow('STRIPE_MONTHLY_CHARGE_SOURCE_CHANGED');
    expect(stripe.invoiceItems.create).toHaveBeenCalledOnce();
  });

  it('holds an expired ambiguous attempt and never creates a second item', async () => {
    const stripe = { invoiceItems: { list: vi.fn().mockResolvedValue({
      data: [], has_more: false }), create: vi.fn() } };
    const nextMonth = '2026-10';
    const nextStart = endsAt;
    const nextEnd = new Date('2026-11-01T00:00:00.000Z');
    const input = { ...params('in_next'), billingMonth: nextMonth,
      periodStartsAt: nextStart, periodEndsAt: nextEnd };
    const nextQuote = { ...quote(), billingMonth: nextMonth };
    const deps = { prisma: db.prisma, stripe: stripe as never,
      quote: vi.fn().mockResolvedValue(nextQuote),
      now: () => new Date('2026-11-01T01:00:00.000Z') };
    stripe.invoiceItems.create.mockRejectedValueOnce(new Error('lost acknowledgement'));
    await expect(collectStripeMonthlyCharge(input, deps)).rejects.toThrow('lost acknowledgement');
    await expect(db.prisma.billingStripeMonthlyCharge.update({
      where: { subscriptionId_billingMonth: { subscriptionId, billingMonth: nextMonth } },
      data: { firstAttemptAt: new Date('2026-10-30T00:00:00.000Z') },
    })).rejects.toThrow();
    // A real attempt timestamp is immutable; advance the clock beyond its
    // conservative 23-hour key window instead of rewriting evidence.
    deps.now = () => new Date('2026-11-02T01:00:00.000Z');
    await expect(collectStripeMonthlyCharge(input, deps))
      .rejects.toThrow('STRIPE_MONTHLY_CHARGE_RETRY_KEY_EXPIRED');
    expect(stripe.invoiceItems.create).toHaveBeenCalledOnce();
  });

  it('freezes a zero-seat closed month without a provider item or later positive repricing', async () => {
    const billingMonth = '2026-11';
    const stripe = { invoiceItems: { list: vi.fn(), create: vi.fn() } };
    const input = { ...params('in_zero'), billingMonth,
      periodStartsAt: new Date('2026-11-01T00:00:00.000Z'),
      periodEndsAt: new Date('2026-12-01T00:00:00.000Z') };
    const frozenQuote = { ...quote(0n), billingMonth };
    const quoteSource = vi.fn().mockResolvedValue(frozenQuote);
    await collectStripeMonthlyCharge(input, { prisma: db.prisma, stripe: stripe as never,
      quote: quoteSource, now: () => new Date('2026-12-01T01:00:00.000Z') });
    expect(await db.prisma.billingStripeMonthlyCharge.findUniqueOrThrow({
      where: { subscriptionId_billingMonth: { subscriptionId, billingMonth } },
    })).toMatchObject({ state: 'NO_CHARGE', amountMinor: 0n,
      stripeInvoiceItemId: null, firstAttemptAt: null });
    quoteSource.mockResolvedValue({ ...frozenQuote, amountMinor: 2500n });
    await expect(collectStripeMonthlyCharge(input, { prisma: db.prisma,
      stripe: stripe as never, quote: quoteSource,
      now: () => new Date('2026-12-02T00:00:00.000Z') }))
      .rejects.toThrow('STRIPE_MONTHLY_CHARGE_SOURCE_CHANGED');
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled();
  });

  it('never creates a second item for a flat recurring subscription price', async () => {
    const stripe = { invoiceItems: { list: vi.fn(), create: vi.fn() } };
    const billingMonth = '2026-12';
    const input = { ...params('in_flat'), billingMonth,
      stripeMonthlyItemId: 'si_flat_price',
      monthlyLineObserved: true,
      periodStartsAt: new Date('2026-12-01T00:00:00.000Z'),
      periodEndsAt: new Date('2027-01-01T00:00:00.000Z') };
    const deps = { prisma: db.prisma, stripe: stripe as never,
      quote: vi.fn().mockResolvedValue({ ...quote(2500n), billingMonth,
        chargeBasis: 'FLAT' }),
    };
    await collectStripeMonthlyCharge(input, deps);
    await expect(collectStripeMonthlyCharge({ ...input, monthlyLineObserved: false }, deps))
      .rejects.toThrow('STRIPE_FLAT_MONTHLY_PRICE_MISSING');
    await collectStripeMonthlyCharge({ ...input, monthlyLineObserved: false,
      closingCancellation: true }, deps);
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled();
    expect(await db.prisma.billingStripeMonthlyCharge.count({
      where: { subscriptionId, billingMonth },
    })).toBe(0);
  });
});
