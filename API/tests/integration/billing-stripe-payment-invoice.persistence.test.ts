import { createHash, randomUUID } from 'node:crypto';

import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/utils/errors.js';
import { stripeInvoiceCashDigest } from '../../src/services/billing-stripe-payment-evidence.service.js';
import {
  downloadCustomerInvoice, getCustomerInvoiceDetail, listCustomerInvoices,
} from '../../src/services/billing-customer-invoice-read.service.js';
import type { BillingCycleContext } from '../../src/services/billing-cycle-read.service.js';
import {
  projectStripeCustomerInvoiceDetail, projectStripeCustomerInvoiceSummary,
} from '../../src/services/billing-customer-invoice-stripe.service.js';
import { prepareStripePaymentInvoice, persistStripePaymentInvoice }
  from '../../src/services/billing-stripe-payment-invoice-source.service.js';
import { issueStripePaymentInvoice } from '../../src/services/billing-stripe-payment-invoice-issue.service.js';
import { runStripePaymentInvoiceCycle } from '../../src/services/billing-stripe-payment-invoice-scheduler.service.js';
import { handleStripeWebhook } from '../../src/services/billing-stripe-webhook.service.js';
import { prepareStripePaymentAdjustment, persistStripePaymentAdjustment }
  from '../../src/services/billing-stripe-payment-adjustment-source.service.js';
import { createTestDb } from '../helpers/test-db.js';

vi.mock('../../src/services/billing-actor.service.js', () => ({
  verifyBillingActor: vi.fn().mockResolvedValue({}),
}));

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
const startsAt = new Date('2026-08-01T00:00:00.000Z');
const endsAt = new Date('2026-09-01T00:00:00.000Z');
const paidAt = new Date('2026-10-01T00:00:00.000Z');
const pdf = Buffer.from('%PDF-1.7\nverified invoice\n%%EOF');

describe.skipIf(!process.env.DATABASE_URL)('regular Stripe payment legal source', () => {
  let db: TestDb; let accountId: string;
  let serviceId: string; let tariffId: string; let orgId: string; let product: string;
  let ownerId: string; let teamManagerId: string; let selectedTeamId: string;
  function context(userId = ownerId): BillingCycleContext {
    return { credential: { service: { id: serviceId, identifier: product,
      name: 'Monthly service' } } as BillingCycleContext['credential'],
    actorToken: 'verified-test-actor', endpoint: '/billing/v1/invoices/list',
    request: { product, organisationId: orgId, teamId: selectedTeamId, userId } };
  }
  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const owner = await db.prisma.user.create({ data: {
      email: `${randomUUID()}@example.test`, userKey: `${randomUUID()}@example.test`,
    } });
    ownerId = owner.id;
    const teamManager = await db.prisma.user.create({ data: {
      email: `${randomUUID()}@example.test`, userKey: `${randomUUID()}@example.test`,
    } });
    teamManagerId = teamManager.id;
    const org = await db.prisma.organisation.create({ data: {
      ownerId: owner.id, domain: `${randomUUID()}.example.test`,
      slug: `monthly-${randomUUID().slice(0, 8)}`, name: 'Monthly seat customer',
    } });
    orgId = org.id;
    const team = await db.prisma.team.create({ data: { orgId,
      name: 'Selected team', slug: `selected-${randomUUID().slice(0, 8)}` } });
    selectedTeamId = team.id;
    await db.prisma.orgMember.create({ data: { orgId, userId: owner.id, role: 'owner' } });
    await db.prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id,
      teamRole: 'owner' } });
    await db.prisma.orgMember.create({ data: { orgId, userId: teamManager.id, role: 'member' } });
    await db.prisma.teamMember.create({ data: { teamId: team.id, userId: teamManager.id,
      teamRole: 'admin' } });
    const service = await db.prisma.billingService.create({ data: {
      identifier: `monthly-${randomUUID()}`, name: 'Monthly service',
    } });
    serviceId = service.id;
    product = service.identifier;
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
      where: { stripeInvoiceId: fixture.invoice.id },
      include: { lines: true, subscription: true, cashPayments: true, adjustments: true } });
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
    const pending = projectStripeCustomerInvoiceSummary(row, product, serviceId);
    expect(pending).toMatchObject({ invoice_id: `stripe:${row.id}`,
      status: 'pending_document', charged_at: paidAt.toISOString(),
      number: null, document_available: false,
      totals: { gross_total: { amount_minor: '2500' }, tax: { amount_minor: '500' },
        credits_applied: { amount_minor: '500' }, total_paid: { amount_minor: '2000' } } });
    expect(projectStripeCustomerInvoiceDetail(row, product, serviceId, { product,
      organisation_id: orgId, team_id: 'selected-team', user_id: 'owner' }).document).toBeNull();
    const prior = { invoice_payment_id: 'inpay_prior', payment_intent_id: 'pi_prior',
      charge_id: 'ch_prior', amount_minor: '1000', paid_at: '2026-09-30T23:59:59.000Z' };
    const current = { invoice_payment_id: 'inpay_current', payment_intent_id: 'pi_current',
      charge_id: 'ch_current', amount_minor: '1000', paid_at: paidAt.toISOString() };
    const cash = [prior, current].map((payment, index) => ({ ...row.cashPayments[0]!,
      id: `uoa_cash_${index}`, stripeInvoicePaymentId: payment.invoice_payment_id,
      stripePaymentIntentId: payment.payment_intent_id,
      stripeChargeId: payment.charge_id, amountMinor: 1000n,
      paidAt: new Date(payment.paid_at), evidenceDigest: stripeInvoiceCashDigest(payment) }));
    const splitPayments = { ...row, paymentEvidence: [prior], paidAmountMinor: 1000n,
      paidAt: new Date(prior.paid_at), stripePaymentIntentIds: [prior.payment_intent_id],
      cashPayments: cash };
    expect(projectStripeCustomerInvoiceSummary(splitPayments, product, serviceId, '2026-09')
      .payments_in_charge_month.amount_minor).toBe('1000');
    expect(projectStripeCustomerInvoiceSummary(splitPayments, product, serviceId, '2026-10')
      .payments_in_charge_month.amount_minor).toBe('1000');
    expect(projectStripeCustomerInvoiceDetail(splitPayments, product, serviceId, { product,
      organisation_id: orgId, team_id: 'selected-team', user_id: 'owner' }, '2026-09')
      .payments.map((payment) => payment.amount.amount_minor)).toEqual(['1000', '1000']);
    const customerDetail = await getCustomerInvoiceDetail(context(), `stripe:${row.id}`,
      { prisma: db.prisma });
    expect(customerDetail.status).toBe('pending_document');
    await expect(getCustomerInvoiceDetail(context(), `stripe:${row.id}`,
      { prisma: db.prisma, chargeMonth: '2026-09' }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(JSON.stringify(customerDetail)).not.toMatch(
      /provider_cost|markup|raw_units|token_count|stripe_customer_id|payment_intent_id/i);
    await expect(getCustomerInvoiceDetail(context(teamManagerId), `stripe:${row.id}`,
      { prisma: db.prisma })).rejects.toMatchObject({ statusCode: 403 });
    expect((await listCustomerInvoices(context(), { chargeMonth: '2026-10' },
      { prisma: db.prisma })).invoices.some((item) => item.invoice_id === `stripe:${row.id}`))
      .toBe(true);
    expect(() => projectStripeCustomerInvoiceSummary({ ...row,
      lines: [{ ...row.lines[0]!, serviceIdentifier: 'another-product' }] }, product, serviceId))
      .toThrow('BILLING_CUSTOMER_STRIPE_INVOICE_SOURCE_UNPROVEN');
    expect(() => projectStripeCustomerInvoiceSummary({ ...row,
      lines: [{ ...row.lines[0]!, serviceId: 'other-service' }] }, product, serviceId))
      .toThrow('BILLING_CUSTOMER_STRIPE_INVOICE_SOURCE_UNPROVEN');
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

  it('refuses concurrent reuse of one captured payment across different legal invoices', async () => {
    const first = await setup(); const second = await setup();
    const payment = await first.stripe.invoicePayments.list();
    (second.stripe.invoicePayments.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ ...payment.data[0], id: second.paymentId, invoice: second.invoice.id }], has_more: false });
    second.stripe.paymentIntents.retrieve = first.stripe.paymentIntents.retrieve;
    second.stripe.charges.retrieve = first.stripe.charges.retrieve;
    const [a, b] = await Promise.all([prepare(first), prepare(second)]);
    const results = await Promise.allSettled([
      db.prisma.$transaction((tx) => persistStripePaymentInvoice(tx, a)),
      db.prisma.$transaction((tx) => persistStripePaymentInvoice(tx, b)),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1);
    expect(await db.prisma.billingStripePaymentInvoice.count({
      where: { stripePaymentIntentIds: { has: first.intentId } } })).toBe(1);
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
    const issuedWithLines = await db.prisma.billingStripePaymentInvoice.findUniqueOrThrow({
      where: { id: source.id },
      include: { lines: true, subscription: true, cashPayments: true, adjustments: true } });
    const detail = projectStripeCustomerInvoiceDetail(issuedWithLines, product, serviceId, { product,
      organisation_id: orgId, team_id: 'selected-team', user_id: 'owner' });
    expect(detail.status).toBe('paid');
    expect(JSON.stringify(detail)).not.toMatch(
      /provider_cost|markup|raw_units|token_count|stripe_customer_id|payment_intent_id/i);
    expect(detail.document?.download_action.body.invoice_id).toBe(`stripe:${source.id}`);
    expect(detail.charges).toMatchObject([{ kind: 'service_charge',
      amount: { amount_minor: '2000' } }]);
    const downloaded = await downloadCustomerInvoice(context(), `stripe:${source.id}`,
      `stripe:${source.id}`, { prisma: db.prisma, storage });
    expect(downloaded.bytes).toEqual(pdf);
    await expect(downloadCustomerInvoice(context(teamManagerId), `stripe:${source.id}`,
      `stripe:${source.id}`, { prisma: db.prisma, storage }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(files.size).toBe(1);
    await expect(db.prisma.billingStripePaymentInvoiceLine.create({ data: {
      invoiceId: source.id, stripeLineId: 'il_extra', serviceId,
      serviceIdentifier: 'changed', billingMonth: '2026-08', label: 'extra',
      subscriptionMinor: 1n, usageMinor: 0n, taxMinor: 0n, creditMinor: 0n,
      grossMinor: 1n, dueMinor: 1n } })).rejects.toThrow();
    await expect(db.prisma.billingStripePaymentInvoice.update({ where: { id: source.id },
      data: { pdfSha256: 'a'.repeat(64) } })).rejects.toThrow();
  });

  it('records partial cash in each actual month beneath one immutable legal invoice', async () => {
    const fixture = await setup();
    const firstAt = '2026-09-10T12:00:00.000Z';
    const firstPayment = (await fixture.stripe.invoicePayments.list()).data[0]!;
    const initialIntent = await fixture.stripe.paymentIntents.retrieve(fixture.intentId);
    const initialCharge = await fixture.stripe.charges.retrieve(fixture.chargeId);
    const first = { ...firstPayment, amount_paid: 1000,
      status_transitions: { ...firstPayment.status_transitions, paid_at: Date.parse(firstAt) / 1000 } };
    fixture.invoice.status = 'open'; fixture.invoice.amount_paid = 1000;
    fixture.invoice.amount_remaining = 1000;
    (fixture.stripe.invoicePayments.list as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ data: [first], has_more: false });
    (fixture.stripe.paymentIntents.retrieve as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ ...initialIntent, amount_received: 1000 });
    (fixture.stripe.charges.retrieve as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ ...initialCharge, amount_captured: 1000 });
    const event = { id: `evt_partial_${fixture.invoice.id}`, type: 'invoice_payment.paid',
      api_version: '2026-06-24.dahlia', livemode: false, account: fixture.account.stripeAccountId,
      created: Date.parse(firstAt) / 1000 + 100, data: { object: first } };
    (fixture.stripe.webhooks.constructEvent as unknown as ReturnType<typeof vi.fn>).mockReturnValue(event);
    const request = { rawBody: Buffer.from('{}'), signature: 'verified-fixture' };
    const deps = { prisma: db.prisma, stripe: fixture.stripe, stripeLivemode: false,
      webhookSecret: 'fixture-secret', collectionEnabled: true };
    await handleStripeWebhook(request, deps);
    const source = await db.prisma.billingStripePaymentInvoice.findFirstOrThrow({
      where: { stripeInvoiceId: fixture.invoice.id }, include: { cashPayments: true } });
    expect(source.paidAmountMinor).toBe(1000n); expect(source.cashPayments).toHaveLength(1);
    const initialDigest = source.sourceDigest;
    const storage = { putImmutable: vi.fn().mockResolvedValue(undefined), read: vi.fn() };
    const download = vi.fn().mockImplementation(async () => new Response(pdf)) as unknown as typeof fetch;
    await issueStripePaymentInvoice(source.id, { prisma: db.prisma, stripe: fixture.stripe,
      account: fixture.account, storage, download });
    const firstMonth = await listCustomerInvoices(context(), { chargeMonth: '2026-09', limit: 1 },
      { prisma: db.prisma });
    expect(firstMonth.invoices).toMatchObject([{ invoice_id: `stripe:${source.id}`,
      status: 'partially_paid', charge_month: '2026-09',
      payments_in_charge_month: { amount_minor: '1000' },
      totals: { total_paid: { amount_minor: '1000' }, outstanding: { amount_minor: '1000' } } }]);
    const secondIntentId = `${fixture.intentId}_second`; const secondChargeId = `${fixture.chargeId}_second`;
    const second = { ...first, id: `${first.id}_second`,
      payment: { type: 'payment_intent', payment_intent: secondIntentId },
      status_transitions: { ...first.status_transitions, paid_at: paidAt.getTime() / 1000 } };
    fixture.invoice.status = 'paid'; fixture.invoice.amount_paid = 2000;
    fixture.invoice.amount_remaining = 0;
    (fixture.stripe.invoicePayments.list as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ data: [first, second], has_more: false });
    (fixture.stripe.paymentIntents.retrieve as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation(async (id: string) => ({ ...initialIntent, id, amount_received: 1000,
        latest_charge: id === fixture.intentId ? fixture.chargeId : secondChargeId }));
    (fixture.stripe.charges.retrieve as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation(async (id: string) => ({ ...initialCharge, id, amount_captured: 1000,
        payment_intent: id === fixture.chargeId ? fixture.intentId : secondIntentId }));
    (fixture.stripe.webhooks.constructEvent as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValue({ ...event, id: `${event.id}_second`, created: paidAt.getTime() / 1000,
        data: { object: second } });
    await handleStripeWebhook(request, deps);
    const final = await db.prisma.billingStripePaymentInvoice.findUniqueOrThrow({
      where: { id: source.id }, include: { cashPayments: { orderBy: { paidAt: 'asc' } } } });
    expect(final.sourceDigest).toBe(initialDigest); expect(final.paidAmountMinor).toBe(1000n);
    expect(final.state).toBe('ISSUED'); expect(final.cashPayments).toHaveLength(2);
    expect(final.cashPayments.map((row) => [row.paidAt.toISOString(), row.amountMinor]))
      .toEqual([[firstAt, 1000n], [paidAt.toISOString(), 1000n]]);
    expect(final.cashPayments.reduce((sum, row) => sum + row.amountMinor, 0n)).toBe(2000n);
    const september = await listCustomerInvoices(context(), { chargeMonth: '2026-09', limit: 1 },
      { prisma: db.prisma });
    const october = await listCustomerInvoices(context(), { chargeMonth: '2026-10', limit: 1 },
      { prisma: db.prisma });
    for (const [month, page] of [['2026-09', september], ['2026-10', october]] as const) {
      const item = page.invoices.find((invoice) => invoice.invoice_id === `stripe:${source.id}`);
      expect(item).toMatchObject({ charge_month: month, status: 'paid',
        payments_in_charge_month: { amount_minor: '1000' },
        totals: { total_paid: { amount_minor: '2000' }, outstanding: { amount_minor: '0' } } });
    }
    const historical = await getCustomerInvoiceDetail(context(), `stripe:${source.id}`,
      { prisma: db.prisma, chargeMonth: '2026-09' });
    expect(historical.payments.map((payment) => payment.payment_id))
      .toEqual(final.cashPayments.map((payment) => payment.id));
    expect(historical.payments_in_charge_month.amount_minor).toBe('1000');
    const octoberIds: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const next = await listCustomerInvoices(context(), { chargeMonth: '2026-10', limit: 1,
        cursor }, { prisma: db.prisma });
      octoberIds.push(...next.invoices.map((invoice) => invoice.invoice_id));
      if (!next.next_cursor) break;
      cursor = next.next_cursor;
    }
    expect(octoberIds).toContain(`stripe:${source.id}`);
    expect(new Set(octoberIds).size).toBe(octoberIds.length);
    expect(storage.putImmutable).toHaveBeenCalledTimes(1);
  });

  it('does not create a cash invoice for a zero-charge subscription activation', async () => {
    const fixture = await setup(); fixture.invoice.amount_due = 0; fixture.invoice.amount_paid = 0;
    expect(await prepareStripePaymentInvoice(fixture.invoice.id, fixture.account, db.prisma,
      fixture.stripe)).toBeNull();
    expect(fixture.stripe.invoicePayments.list).not.toHaveBeenCalled();
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

  it('records proven refund cash once, retains invoice debt and leaves prepaid credits alone', async () => {
    const fixture = await setup();
    const refund = { id: `re_${fixture.invoice.id}`, livemode: false, amount: 300, currency: 'usd',
      status: 'succeeded', payment_intent: fixture.intentId, charge: fixture.chargeId,
      balance_transaction: `bt_${fixture.invoice.id}` };
    fixture.stripe.refunds = { retrieve: vi.fn().mockResolvedValue(refund) } as unknown as Stripe['refunds'];
    fixture.stripe.balanceTransactions = { retrieve: vi.fn().mockResolvedValue({
      id: refund.balance_transaction, amount: -300, currency: 'usd', source: refund.id,
      exchange_rate: null, created: paidAt.getTime() / 1000 + 100,
    }) } as unknown as Stripe['balanceTransactions'];
    const event = { id: `evt_refund_${fixture.invoice.id}`, type: 'refund.updated',
      api_version: '2026-06-24.dahlia', livemode: false, account: fixture.account.stripeAccountId,
      created: paidAt.getTime() / 1000 + 900, data: { object: refund } } as unknown as Stripe.Event;
    (fixture.stripe.webhooks.constructEvent as unknown as ReturnType<typeof vi.fn>).mockReturnValue(event);
    const request = { rawBody: Buffer.from('{}'), signature: 'verified-fixture' };
    const deps = { prisma: db.prisma, stripe: fixture.stripe, stripeLivemode: false,
      webhookSecret: 'fixture-secret', collectionEnabled: true };
    expect(await handleStripeWebhook(request, deps)).toEqual({ duplicate: false });
    expect(await handleStripeWebhook(request, deps)).toEqual({ duplicate: true });
    const source = await db.prisma.billingStripePaymentInvoice.findFirstOrThrow({
      where: { stripeInvoiceId: fixture.invoice.id } });
    const adjustment = await db.prisma.billingStripePaymentInvoiceAdjustment.findFirstOrThrow({
      where: { invoiceId: source.id } });
    expect(adjustment).toMatchObject({ kind: 'REFUND', amountMinor: 300n,
      occurredAt: new Date(paidAt.getTime() + 100_000) });
    const unchanged = await db.prisma.billingStripePaymentInvoice.findUniqueOrThrow({ where: { id: source.id } });
    expect([unchanged.dueAmountMinor, unchanged.paidAmountMinor]).toEqual([2000n, 2000n]);
    expect(await db.prisma.billingCreditEntry.count({ where: { creditAccount: { orgId } } })).toBe(0);
    await expect(db.prisma.billingStripePaymentInvoiceAdjustment.update({ where: { id: adjustment.id },
      data: { amountMinor: 301n } })).rejects.toThrow();
    const changed = { ...event, id: `evt_again_${fixture.invoice.id}` };
    const same = await prepareStripePaymentAdjustment(changed, fixture.stripe, fixture.account, db.prisma);
    if (!same) throw new Error('ADJUSTMENT_REQUIRED');
    expect((await db.prisma.$transaction((tx) => persistStripePaymentAdjustment(tx, same))).id)
      .toBe(adjustment.id);
    await expect(db.prisma.$transaction((tx) => persistStripePaymentAdjustment(tx,
      { ...same, stripeObjectId: `re_second_${fixture.invoice.id}`, amountMinor: 1800n })))
      .rejects.toThrow('REFUND_TOTAL_UNPROVEN');
    const pending = { ...refund, status: 'pending' };
    (fixture.stripe.refunds.retrieve as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(pending);
    expect(await prepareStripePaymentAdjustment({ ...event, data: { object: pending } } as Stripe.Event,
      fixture.stripe, fixture.account, db.prisma)).toBeNull();
  });

  it('records actual dispute withdrawal and reinstatement without erasing the original cash', async () => {
    const fixture = await setup(); const prepared = await prepare(fixture);
    const source = await db.prisma.$transaction((tx) => persistStripePaymentInvoice(tx, prepared));
    const withdrawn = { id: `dp_${fixture.invoice.id}`, livemode: false, amount: 700,
      currency: 'usd', payment_intent: fixture.intentId, charge: fixture.chargeId,
      status: 'needs_response', balance_transactions: [{ id: `bt_out_${fixture.invoice.id}`,
        amount: -850, currency: 'usd', exchange_rate: null, created: paidAt.getTime() / 1000 + 100 }] };
    fixture.stripe.disputes = { retrieve: vi.fn().mockResolvedValue(withdrawn) } as unknown as Stripe['disputes'];
    const event = { id: `evt_dispute_${fixture.invoice.id}`, type: 'charge.dispute.funds_withdrawn',
      created: paidAt.getTime() / 1000 + 900, data: { object: withdrawn } } as unknown as Stripe.Event;
    const withdrawal = await prepareStripePaymentAdjustment(event, fixture.stripe, fixture.account, db.prisma);
    if (!withdrawal) throw new Error('ADJUSTMENT_REQUIRED');
    // Deliver reinstatement first; the same verified balance movement set
    // must recover the earlier withdrawal rather than invent a cash gain.
    expect(withdrawal.amountMinor).toBe(700n); // Provider dispute fee is not customer principal.
    const reinstated = { ...withdrawn, status: 'won', balance_transactions: [
      ...withdrawn.balance_transactions, { id: `bt_in_${fixture.invoice.id}`, amount: 700,
        currency: 'usd', exchange_rate: null, created: paidAt.getTime() / 1000 + 200 }] };
    (fixture.stripe.disputes.retrieve as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(reinstated);
    const restored = await prepareStripePaymentAdjustment({ ...event,
      id: `evt_restore_${fixture.invoice.id}`, type: 'charge.dispute.funds_reinstated',
      data: { object: reinstated } } as unknown as Stripe.Event, fixture.stripe, fixture.account, db.prisma);
    if (!restored) throw new Error('ADJUSTMENT_REQUIRED');
    await db.prisma.$transaction((tx) => persistStripePaymentAdjustment(tx, restored));
    expect(restored).toMatchObject({ kind: 'DISPUTE_REVERSAL', amountMinor: 700n,
      occurredAt: new Date(paidAt.getTime() + 200_000) });
    expect(await prepareStripePaymentAdjustment(event, fixture.stripe, fixture.account, db.prisma)).toBeNull();
    expect(await db.prisma.billingStripePaymentInvoiceCashPayment.count({ where: { invoiceId: source.id } })).toBe(1);
    expect(await db.prisma.billingStripePaymentInvoiceAdjustment.count({ where: { invoiceId: source.id } })).toBe(2);
  });

});
