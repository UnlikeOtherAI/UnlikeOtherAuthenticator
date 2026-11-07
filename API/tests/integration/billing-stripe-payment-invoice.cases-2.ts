
import type Stripe from 'stripe';
import { expect, it, vi } from 'vitest';

import { persistStripePaymentInvoice } from '../../src/services/billing-stripe-payment-invoice-source.service.js';

import { handleStripeWebhook } from '../../src/services/billing-stripe-webhook.service.js';
import { prepareStripePaymentAdjustment, persistStripePaymentAdjustment } from '../../src/services/billing-stripe-payment-adjustment-source.service.js';

import { paidAt, db, orgId, setup, prepare } from './billing-stripe-payment-invoice.suite-fixture.js';

export function registerCases2() {
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
}
