import { createHash } from 'node:crypto';

import { expect, it, vi } from 'vitest';
import { AppError } from '../../src/utils/errors.js';
import { stripeInvoiceCashDigest } from '../../src/services/billing-stripe-payment-evidence.service.js';
import { downloadCustomerInvoice, getCustomerInvoiceDetail, listCustomerInvoices } from '../../src/services/billing-customer-invoice-read.service.js';

import { projectStripeCustomerInvoiceDetail, projectStripeCustomerInvoiceSummary } from '../../src/services/billing-customer-invoice-stripe.service.js';
import { prepareStripePaymentInvoice, persistStripePaymentInvoice } from '../../src/services/billing-stripe-payment-invoice-source.service.js';
import { issueStripePaymentInvoice } from '../../src/services/billing-stripe-payment-invoice-issue.service.js';
import { runStripePaymentInvoiceCycle } from '../../src/services/billing-stripe-payment-invoice-scheduler.service.js';
import { handleStripeWebhook } from '../../src/services/billing-stripe-webhook.service.js';

import { endsAt, paidAt, pdf, db, serviceId, orgId, product, teamManagerId, context, setup, prepare } from './billing-stripe-payment-invoice.suite-fixture.js';

export function registerCases1() {

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
      { prisma: db.prisma })).rejects.toMatchObject({ statusCode: 403, message: 'BILLING_MANAGER_REQUIRED' });
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
    const readsBeforeRefusal = storage.read.mock.calls.length;
    await expect(downloadCustomerInvoice(context(teamManagerId), `stripe:${source.id}`,
      `stripe:${source.id}`, { prisma: db.prisma, storage }))
      .rejects.toMatchObject({ statusCode: 403, message: 'BILLING_MANAGER_REQUIRED' });
    expect(storage.read).toHaveBeenCalledTimes(readsBeforeRefusal);
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
}
