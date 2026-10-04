import { createHash, randomUUID } from 'node:crypto';

import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/utils/errors.js';
import { prepareStripePaymentInvoice, persistStripePaymentInvoice }
  from '../../src/services/billing-stripe-payment-invoice-source.service.js';
import { issueStripePaymentInvoice } from '../../src/services/billing-stripe-payment-invoice-issue.service.js';
import { runStripePaymentInvoiceCycle } from '../../src/services/billing-stripe-payment-invoice-scheduler.service.js';
import { handleStripeWebhook } from '../../src/services/billing-stripe-webhook.service.js';
import { createTestDb } from '../helpers/test-db.js';

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
const startsAt = new Date('2026-08-01T00:00:00.000Z');
const endsAt = new Date('2026-09-01T00:00:00.000Z');
const paidAt = new Date('2026-10-01T00:00:00.000Z');
const pdf = Buffer.from('%PDF-1.7\nverified invoice\n%%EOF');

describe.skipIf(!process.env.DATABASE_URL)('regular Stripe payment legal source', () => {
  let db: TestDb; let accountId: string;
  let serviceId: string; let tariffId: string; let orgId: string;
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
      monthlyAmountMinor: 2500n, monthlyChargeBasis: 'FLAT',
      currency: 'USD',
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
    await db.prisma.billingStripeSubscription.create({ data: {
      accountId, checkoutId: checkout.id, customerId: customer.id,
      serviceId, tariffId, tariffSource: 'SERVICE_DEFAULT',
      orgId, teamId: null, scope: 'ORGANISATION', scopeKey: orgId,
      stripeSubscriptionId: 'sub_monthly', stripeUsageItemId: 'si_metered',
      stripeMonthlyItemId: 'si_monthly', status: 'active', livemode: false,
      currentPeriodStart: endsAt,
      currentPeriodEnd: new Date('2026-11-01T00:00:00.000Z'),
    } });
  });
  afterAll(async () => { if (db) await db.cleanup(); });

  async function setup(id = `in_${randomUUID().replaceAll('-', '')}`) {
    const account = await db.prisma.billingStripeAccount.findUniqueOrThrow({ where: { id: accountId } });
    const invoice = { id, livemode: false, status: 'paid', customer: 'cus_monthly', currency: 'usd',
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_monthly' } },
      billing_reason: 'subscription_create', amount_paid: 2000, amount_due: 2000, amount_remaining: 0,
      total: 2500, total_taxes: [{ amount: 500 }], number: `INV-${id}`,
      account_name: 'Verified seller', account_country: 'GB', customer_name: 'Verified buyer',
      customer_email: 'finance@example.test', customer_address: { country: 'GB', line1: '1 Road',
        line2: null, city: 'London', postal_code: 'SW1A 1AA', state: null },
      status_transitions: { finalized_at: endsAt.getTime() / 1000, paid_at: paidAt.getTime() / 1000 },
      effective_at: null, invoice_pdf: 'https://pay.stripe.com/invoice/test.pdf',
    };
    const paymentId = `inpay_${id}`; const intentId = `pi_${id}`; const chargeId = `ch_${id}`;
    const lines = [{ id: `il_${id}`, invoice: id, currency: 'usd', livemode: false, amount: 2500,
      parent: { type: 'subscription_item_details', subscription_item_details: {
        subscription: 'sub_monthly', subscription_item: 'si_monthly', proration: false } },
      period: { start: startsAt.getTime() / 1000, end: endsAt.getTime() / 1000 },
      discount_amounts: [], pretax_credit_amounts: [], taxes: [{ amount: 500, tax_behavior: 'inclusive' }],
    }];
    const stripe = { accounts: { retrieveCurrent: vi.fn().mockResolvedValue({ id: account.stripeAccountId }) },
      invoices: { retrieve: vi.fn().mockResolvedValue(invoice),
        listLineItems: vi.fn().mockResolvedValue({ data: lines, has_more: false }) },
      invoicePayments: { list: vi.fn().mockResolvedValue({ data: [{ id: paymentId,
        invoice: id, livemode: false, currency: 'usd', status: 'paid', amount_paid: 2000,
        payment: { type: 'payment_intent', payment_intent: intentId },
        status_transitions: { paid_at: paidAt.getTime() / 1000 } }], has_more: false }) },
      paymentIntents: { retrieve: vi.fn().mockResolvedValue({ id: intentId, latest_charge: chargeId,
        customer: 'cus_monthly', currency: 'usd', livemode: false, status: 'succeeded', amount_received: 2000 }) },
      charges: { retrieve: vi.fn().mockResolvedValue({ id: chargeId, payment_intent: intentId,
        customer: 'cus_monthly', currency: 'usd', livemode: false, status: 'succeeded',
        paid: true, captured: true, amount_captured: 2000 }) },
      subscriptions: { retrieve: vi.fn() }, webhooks: { constructEvent: vi.fn().mockReturnValue({
        id: `evt_${id}`, type: 'invoice.paid', api_version: '2026-06-24.dahlia',
        livemode: false, account: account.stripeAccountId, created: paidAt.getTime() / 1000 + 300,
        data: { object: invoice } }) },
    };
    return { account, invoice, lines, stripe: stripe as unknown as Stripe,
      intentId, paymentId, chargeId };
  }

  async function prepare(fixture: Awaited<ReturnType<typeof setup>>) {
    const prepared = await prepareStripePaymentInvoice(fixture.invoice.id, fixture.account,
      db.prisma, fixture.stripe);
    if (!prepared) throw new Error('SOURCE_REQUIRED');
    return prepared;
  }

  it('freezes the actual cash date, exact legal allocations and duplicate webhook once', async () => {
    const fixture = await setup();
    const request = { rawBody: Buffer.from('{}'), signature: 'verified-fixture' };
    const deps = { prisma: db.prisma, stripe: fixture.stripe, stripeLivemode: false,
      webhookSecret: 'fixture-secret', collectionEnabled: true };
    expect(await handleStripeWebhook(request, deps)).toEqual({ duplicate: false });
    expect(await handleStripeWebhook(request, deps)).toEqual({ duplicate: true });
    const row = await db.prisma.billingStripePaymentInvoice.findFirstOrThrow({
      where: { stripeInvoiceId: fixture.invoice.id }, include: { lines: true } });
    expect(row.paidAt).toEqual(paidAt);
    expect(row.state).toBe('PENDING');
    expect(row.paymentEvidence).toEqual([{ invoice_payment_id: fixture.paymentId,
      payment_intent_id: fixture.intentId, charge_id: fixture.chargeId,
      amount_minor: '2000', paid_at: paidAt.toISOString() }]);
    expect([row.grossAmountMinor, row.taxAmountMinor, row.creditAmountMinor,
      row.dueAmountMinor, row.paidAmountMinor]).toEqual([2500n, 500n, 500n, 2000n, 2000n]);
    expect(row.lines[0]).toMatchObject({ billingMonth: '2026-08',
      subscriptionMinor: 2000n, usageMinor: 0n, taxMinor: 500n,
      creditMinor: 500n, grossMinor: 2500n, dueMinor: 2000n });
    expect(await db.prisma.billingStripePaymentInvoice.count({
      where: { stripeInvoiceId: fixture.invoice.id } })).toBe(1);
    expect(await db.prisma.billingCreditEntry.count({ where: { creditAccount: { orgId } } })).toBe(0);
    await expect(db.prisma.billingStripePaymentInvoice.update({ where: { id: row.id },
      data: { paidAmountMinor: 2001n } })).rejects.toThrow();
    await expect(db.prisma.billingStripePaymentInvoiceLine.update({ where: { id: row.lines[0]?.id },
      data: { dueMinor: 2001n } })).rejects.toThrow();
  });

  it('holds manually paid, changed cash, unbound lines and incomplete payment pagination', async () => {
    const fixture = await setup();
    const paymentList = fixture.stripe.invoicePayments.list as unknown as ReturnType<typeof vi.fn>;
    const original = await fixture.stripe.invoicePayments.list();
    paymentList.mockResolvedValueOnce({ data: [], has_more: false });
    await expect(prepare(fixture)).rejects.toThrow('PAYMENT_SET_UNPROVEN');
    paymentList.mockResolvedValueOnce({ ...original, has_more: true });
    await expect(prepare(fixture)).rejects.toThrow();
    const intent = await fixture.stripe.paymentIntents.retrieve(fixture.intentId);
    (fixture.stripe.paymentIntents.retrieve as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...intent, amount_received: 2001 });
    await expect(prepare(fixture)).rejects.toThrow('PAYMENT_CASH_UNPROVEN');
    fixture.lines[0]!.parent.subscription_item_details.subscription_item = 'si_other_product';
    await expect(prepare(fixture)).rejects.toThrow('LINES_UNPROVEN');
    expect(await db.prisma.billingStripePaymentInvoice.count({
      where: { stripeInvoiceId: fixture.invoice.id } })).toBe(0);
  });

  it('rolls the source and its lines back together then recovers a persisted PDF lost acknowledgement', async () => {
    const fixture = await setup(); const prepared = await prepare(fixture);
    await expect(db.prisma.$transaction(async (tx) => {
      await persistStripePaymentInvoice(tx, prepared); throw new Error('AFTER_SOURCE_ROLLBACK');
    })).rejects.toThrow('AFTER_SOURCE_ROLLBACK');
    expect(await db.prisma.billingStripePaymentInvoice.count({
      where: { stripeInvoiceId: fixture.invoice.id } })).toBe(0);
    const source = await db.prisma.$transaction((tx) => persistStripePaymentInvoice(tx, prepared));
    const files = new Map<string, Buffer>(); let lostAck = true;
    const storage = { putImmutable: vi.fn().mockImplementation(async (key: string, bytes: Uint8Array) => {
      if (files.has(key)) throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_PDF_ALREADY_EXISTS');
      files.set(key, Buffer.from(bytes));
      if (lostAck) { lostAck = false; throw new Error('STORAGE_ACK_LOST'); }
    }), read: vi.fn().mockImplementation(async (key: string) => files.get(key)!) };
    const download = vi.fn().mockImplementation(async () => new Response(pdf,
      { headers: { 'content-type': 'application/pdf' } })) as unknown as typeof fetch;
    const deps = { prisma: db.prisma, stripe: fixture.stripe, account: fixture.account, storage, download };
    await expect(issueStripePaymentInvoice(source.id, deps)).rejects.toThrow('STORAGE_ACK_LOST');
    const issued = await issueStripePaymentInvoice(source.id, deps);
    expect(issued.state).toBe('ISSUED'); expect(issued.issuedAt).toEqual(endsAt);
    expect(issued.pdfSha256).toBe(createHash('sha256').update(pdf).digest('hex'));
    expect(issued.issuerSnapshot).toMatchObject({ legal_name: 'Verified seller' });
    expect(issued.buyerSnapshot).toMatchObject({ legal_name: 'Verified buyer' });
    expect(files.size).toBe(1);
    await expect(db.prisma.billingStripePaymentInvoiceLine.create({ data: {
      invoiceId: source.id, stripeLineId: 'il_extra', serviceId,
      serviceIdentifier: 'changed', billingMonth: '2026-08', label: 'extra',
      subscriptionMinor: 1n, usageMinor: 0n, taxMinor: 0n, creditMinor: 0n,
      grossMinor: 1n, dueMinor: 1n } })).rejects.toThrow();
    await expect(db.prisma.billingStripePaymentInvoice.update({ where: { id: source.id },
      data: { pdfSha256: 'a'.repeat(64) } })).rejects.toThrow();
  });

  it('leases concurrent document workers and defers failures instead of starving later sources', async () => {
    const fixture = await setup(); const prepared = await prepare(fixture);
    const source = await db.prisma.$transaction((tx) => persistStripePaymentInvoice(tx, prepared));
    const now = new Date(Date.now() + 1000);
    const issue = vi.fn().mockRejectedValue(new Error('PROVIDER_DOWN'));
    const deps = { prisma: db.prisma, stripe: fixture.stripe, livemode: false,
      now: () => now, issue };
    const [a, b] = await Promise.all([runStripePaymentInvoiceCycle(deps), runStripePaymentInvoiceCycle(deps)]);
    expect(a.checked + b.checked).toBeGreaterThanOrEqual(1);
    const selectedCalls = issue.mock.calls.filter(([id]) => id === source.id);
    expect(selectedCalls).toHaveLength(1);
    const held = await db.prisma.billingStripePaymentInvoice.findUniqueOrThrow({ where: { id: source.id } });
    expect(held.state).toBe('HELD'); expect(held.nextIssueAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    expect(held.issueAttemptCount).toBe(1);
  });
});
