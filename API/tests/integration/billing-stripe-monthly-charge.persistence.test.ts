import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type Stripe from 'stripe';

import { collectStripeClosingSeatInvoice } from '../../src/services/billing-stripe-closing-seat-invoice.service.js';
import { createStripeInvoiceFixture } from '../helpers/stripe-payment-invoice-fixture.js';
import { prepareStripePaymentInvoice, persistStripePaymentInvoice }
  from '../../src/services/billing-stripe-payment-invoice-source.service.js';
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

  it('resumes an existing verified renewal after cancellation without a second fee', async () => {
    const original = await db.prisma.billingStripeSubscription.findUniqueOrThrow({
      where: { id: subscriptionId }, include: { checkout: true } });
    const checkout = await db.prisma.billingStripeCheckoutSession.create({ data: {
      accountId, appKeyId: original.checkout.appKeyId, customerId: original.customerId,
      serviceId, tariffId, tariffSource: 'SERVICE_DEFAULT', orgId, teamId: null,
      scope: 'ORGANISATION', scopeKey: orgId, actorJti: randomUUID(),
      requestedByUserId: original.checkout.requestedByUserId, status: 'complete',
      successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64),
      leaseExpiresAt: new Date('2026-10-05T00:00:00Z') } });
    const local = await db.prisma.billingStripeSubscription.create({ data: {
      accountId, checkoutId: checkout.id, customerId: original.customerId,
      serviceId, tariffId, tariffSource: 'SERVICE_DEFAULT', orgId, teamId: null,
      scope: 'ORGANISATION', scopeKey: orgId, stripeSubscriptionId: 'sub_existing_renewal',
      stripeUsageItemId: 'si_existing_renewal', status: 'canceled', livemode: false,
      billableFrom: startsAt, billableUntil: new Date('2026-09-16T00:00:00Z') } });
    const item = { id: 'ii_existing_renewal', invoice: 'in_existing_renewal', customer: 'cus_monthly',
      amount: 5000, currency: 'usd', livemode: false, period: {
        start: startsAt.getTime() / 1000, end: endsAt.getTime() / 1000 }, metadata: {} };
    const frozenQuote = { ...quote(), source: { kind: 'stripe', id: local.id } };
    await collectStripeMonthlyCharge({ ...params(item.invoice), subscriptionId: local.id }, {
      prisma: db.prisma, quote: vi.fn().mockResolvedValue(frozenQuote), stripe: { invoiceItems: {
        list: vi.fn().mockResolvedValue({ data: [], has_more: false }),
        create: vi.fn().mockImplementation(async (input: Record<string, unknown>) =>
          ({ ...item, metadata: input.metadata })) } } as never });
    const account = await db.prisma.billingStripeAccount.findUniqueOrThrow({ where: { id: accountId } });
    const source = await db.prisma.billingStripeMonthlyCharge.findUniqueOrThrow({
      where: { subscriptionId_billingMonth: { subscriptionId: local.id, billingMonth: month } } });
    const invoice = { id: source.stripeInvoiceId, livemode: false, status: 'open', auto_advance: false,
      collection_method: 'charge_automatically', customer: 'cus_monthly', currency: 'usd',
      total: 5000, amount_due: 5000, total_taxes: [],
      parent: { type: 'subscription_details', subscription_details: { subscription: local.stripeSubscriptionId } } };
    let foreign = true;
    const stripe = { accounts: { retrieveCurrent: vi.fn().mockResolvedValue({ id: account.stripeAccountId }) },
      subscriptions: { retrieve: vi.fn() }, invoiceItems: { list: vi.fn(), create: vi.fn() },
      invoices: { retrieve: vi.fn().mockResolvedValue(invoice), create: vi.fn(), finalizeInvoice: vi.fn(),
        update: vi.fn().mockImplementation(async () => Object.assign(invoice, { auto_advance: true })),
        listLineItems: vi.fn().mockImplementation(async () => ({ has_more: false, data: [{
          id: 'il_existing_monthly', invoice: invoice.id, livemode: false, currency: 'usd', amount: 5000,
          period: { start: startsAt.getTime() / 1000, end: endsAt.getTime() / 1000 }, taxes: [],
          parent: { type: 'invoice_item_details', invoice_item_details: { invoice_item: source.stripeInvoiceItemId } },
          discount_amounts: [], pretax_credit_amounts: [],
        }, ...(foreign ? [{ id: 'il_foreign' }] : [])] })) } };
    const deps = { prisma: db.prisma, stripe: stripe as unknown as Stripe, stripeLivemode: false,
      quote: vi.fn().mockResolvedValue(frozenQuote), quoteUsage: vi.fn().mockResolvedValue({
        amountMicroMinor: 0n, currency: 'USD', ledgerSnapshotCursor: 'complete-proof' }) };
    await expect(collectStripeClosingSeatInvoice({ subscriptionId: local.id, billingMonth: month }, deps))
      .rejects.toThrow('STRIPE_SUBSCRIPTION_INVOICE_LINES_UNPROVEN');
    expect(stripe.invoices.update).not.toHaveBeenCalled();
    foreign = false;
    await collectStripeClosingSeatInvoice({ subscriptionId: local.id, billingMonth: month }, deps);
    await collectStripeClosingSeatInvoice({ subscriptionId: local.id, billingMonth: month }, deps);
    expect(stripe.invoices.update).toHaveBeenCalledOnce();
    expect(stripe.invoices.create).not.toHaveBeenCalled();
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled();
    expect((await db.prisma.billingStripeMonthlyCharge.findUniqueOrThrow({ where: { id: source.id } }))
      .stripeInvoiceId).toBe(source.stripeInvoiceId);
  });

  it('recovers one earned closing invoice after cancellation and a lost creation acknowledgement', async () => {
    const closingMonth = '2026-07';
    const start = new Date('2026-07-01T00:00:00.000Z');
    const end = new Date('2026-08-01T00:00:00.000Z');
    const ended = new Date('2026-07-16T00:00:00.000Z');
    const local = await db.prisma.billingStripeSubscription.update({ where: { id: subscriptionId },
      data: { status: 'canceled', billableFrom: start, billableUntil: ended } });
    const account = await db.prisma.billingStripeAccount.findUniqueOrThrow({ where: { id: accountId } });
    const invoices: Array<Record<string, unknown>> = [];
    const items: Array<Record<string, unknown>> = [];
    let unrelatedLine = false;
    const stripe = { accounts: { retrieveCurrent: vi.fn().mockResolvedValue({ id: account.stripeAccountId }) },
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ id: local.stripeSubscriptionId,
        livemode: false, status: 'canceled', customer: 'cus_monthly', default_payment_method: 'pm_monthly',
        metadata: { uoa_checkout_id: local.checkoutId },
        automatic_tax: { enabled: false }, default_tax_rates: [{ id: 'txr_fixture20' }] }) },
      invoices: {
        list: vi.fn().mockImplementation(async () => ({ data: invoices, has_more: false })),
        retrieve: vi.fn().mockImplementation(async () => invoices[0]),
        listLineItems: vi.fn().mockImplementation(async () => ({ data: [...items.map((item) => ({
          ...item, id: 'il_closing', parent: { type: 'invoice_item_details',
            invoice_item_details: { invoice_item: item.id } }, discount_amounts: [], pretax_credit_amounts: [],
        })), ...(unrelatedLine ? [{ id: 'il_unrelated', amount: 1000 }] : [])], has_more: false })),
        create: vi.fn().mockImplementation(async (input: Record<string, unknown>) => {
          invoices.push({ ...input, id: 'in_closing', livemode: false, status: 'draft' });
          throw new Error('invoice accepted; response lost');
        }),
        finalizeInvoice: vi.fn().mockImplementation(async () => {
          Object.assign(invoices[0] ?? {}, { status: 'open', auto_advance: true });
          return invoices[0];
        }),
      },
      invoiceItems: {
        list: vi.fn().mockImplementation(async () => ({ data: items, has_more: false })),
        create: vi.fn().mockImplementation(async (input: Record<string, unknown>) => {
          const item = { ...input, id: 'ii_closing', livemode: false }; items.push(item); return item;
        }),
      },
    };
    const deps = { prisma: db.prisma, stripe: stripe as unknown as Stripe, stripeLivemode: false,
      quote: vi.fn().mockResolvedValue({ ...quote(5000n), billingMonth: closingMonth,
        commercialEffectiveAt: start, commercialEndsAt: ended }), now: () => new Date('2026-10-04T00:00:00.000Z') };
    expect(await collectStripeClosingSeatInvoice({ subscriptionId, billingMonth: '2026-06' }, deps)).toBeNull();
    await expect(collectStripeClosingSeatInvoice({ subscriptionId, billingMonth: closingMonth }, deps))
      .rejects.toThrow('invoice accepted; response lost');
    const frozen = await db.prisma.billingStripeMonthlyCharge.findUniqueOrThrow({
      where: { subscriptionId_billingMonth: { subscriptionId, billingMonth: closingMonth } } });
    expect(frozen).toMatchObject({ allocationKind: 'CLOSING', stripeInvoiceId: null,
      invoiceLeaseToken: null, amountMinor: 5000n });
    expect(frozen.firstInvoiceAttemptAt).not.toBeNull();
    unrelatedLine = true;
    await expect(collectStripeClosingSeatInvoice({ subscriptionId, billingMonth: closingMonth }, deps))
      .rejects.toThrow('STRIPE_CLOSING_INVOICE_LINES_UNPROVEN');
    expect(stripe.invoices.finalizeInvoice).not.toHaveBeenCalled();
    unrelatedLine = false;
    await collectStripeClosingSeatInvoice({ subscriptionId, billingMonth: closingMonth }, deps);
    await collectStripeClosingSeatInvoice({ subscriptionId, billingMonth: closingMonth }, deps);
    expect(stripe.invoices.create).toHaveBeenCalledOnce();
    expect(stripe.invoices.create.mock.calls[0]?.[0]).toMatchObject({
      default_tax_rates: ['txr_fixture20'], automatic_tax: { enabled: false },
      pending_invoice_items_behavior: 'exclude',
    });
    expect(stripe.invoiceItems.create).toHaveBeenCalledOnce();
    expect(stripe.invoices.finalizeInvoice).toHaveBeenCalledOnce();
    const accepted = await db.prisma.billingStripeMonthlyCharge.findUniqueOrThrow({ where: { id: frozen.id } });
    expect(accepted).toMatchObject({ state: 'ACCEPTED', stripeInvoiceId: 'in_closing',
      stripeInvoiceItemId: 'ii_closing', invoiceLeaseToken: null });
    await expect(db.prisma.billingStripeMonthlyCharge.update({ where: { id: frozen.id },
      data: { stripeInvoiceId: 'in_duplicate' } })).rejects.toThrow();
    await collectStripeMonthlyCharge({ ...params('in_renewal_after_cancel'), billingMonth: closingMonth,
      periodStartsAt: start, periodEndsAt: end }, { prisma: db.prisma,
      stripe: deps.stripe, quote: deps.quote });
    expect(stripe.invoiceItems.create).toHaveBeenCalledOnce();
    expect(await db.prisma.billingCreditEntry.count({ where: { creditAccount: { orgId } } })).toBe(0);
    // Cash evidence for a standalone closing invoice must bind through the
    // accepted monthly item rather than an absent Stripe subscription parent.
    const cash = await createStripeInvoiceFixture(db.prisma, accountId, 'in_closing');
    const paidInvoice = { ...cash.invoice, parent: null, amount_paid: 6000, amount_due: 6000,
      total: 6000, total_taxes: [{ amount: 1000 }], metadata: invoices[0]?.metadata };
    (cash.stripe.invoices.retrieve as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(paidInvoice);
    (cash.stripe.invoices.listLineItems as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [{
      id: 'il_closing', invoice: 'in_closing', currency: 'usd', livemode: false, amount: 5000,
      parent: { type: 'invoice_item_details', invoice_item_details: { invoice_item: 'ii_closing' } },
      period: { start: start.getTime() / 1000, end: end.getTime() / 1000 },
      taxes: [{ amount: 1000, tax_behavior: 'exclusive' }], discount_amounts: [], pretax_credit_amounts: [],
    }], has_more: false });
    const payment = await cash.stripe.invoicePayments.list();
    (cash.stripe.invoicePayments.list as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ ...payment, data: [{ ...payment.data[0], amount_paid: 6000 }] });
    const intent = await cash.stripe.paymentIntents.retrieve(cash.intentId);
    (cash.stripe.paymentIntents.retrieve as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ ...intent, amount_received: 6000 });
    const charge = await cash.stripe.charges.retrieve(cash.chargeId);
    (cash.stripe.charges.retrieve as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ ...charge, amount_captured: 6000 });
    const paymentSource = await prepareStripePaymentInvoice('in_closing', cash.account, db.prisma, cash.stripe);
    if (!paymentSource) throw new Error('CLOSING_CASH_SOURCE_REQUIRED');
    const saved = await db.prisma.$transaction((tx) => persistStripePaymentInvoice(tx, paymentSource));
    expect(saved).toMatchObject({ subscriptionId, paidAmountMinor: 6000n, dueAmountMinor: 6000n, taxAmountMinor: 1000n });
  });

});
