import { expect, it, vi } from 'vitest';
import { collectAnniversarySeat, type SeatPayment } from '../../src/services/billing-anniversary-seat-collection.service.js';

it('recovers a lost acknowledgement after renewal and key expiry using the exact Stripe event', async () => {
  const firstAttemptAt = new Date('2026-11-04T20:00:00Z');
  const change: SeatPayment = { id: 19n, delta: 1, fromQuantity: 1, toQuantity: 2, effectiveAt: firstAttemptAt,
    firstAttemptAt, attemptVersion: 1, stripeInvoiceId: null, checkoutId: 'checkout', account: 'acct_test',
    livemode: false, customerId: 'cus_test', subscriptionId: 'sub_test', itemId: 'si_test',
    priceId: 'price_agreed', currency: 'EUR', unitAmount: 299n };
  const nextPeriod = new Date('2026-11-06T00:00:00Z');
  const subscription = { id: 'sub_test', customer: 'cus_test', status: 'active', livemode: false,
    metadata: { uoa_checkout_id: 'checkout', uoa_stripe_account_id: 'acct_test' }, billing_mode: { type: 'classic' },
    latest_invoice: 'in_renewal', items: { data: [{ id: 'si_test', quantity: 2, current_period_start: +nextPeriod / 1000,
      current_period_end: +nextPeriod / 1000 + 30 * 86400, price: { id: 'price_agreed', currency: 'eur', unit_amount: 299,
        recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } } }] } };
  const update = vi.fn();
  const retrieveInvoice = vi.fn(async (id: string) => ({ id, livemode: false, currency: 'eur', customer: 'cus_test',
    status: 'paid', billing_reason: 'subscription_update', parent: { subscription_details: { subscription: 'sub_test' } } }));
  const list = vi.fn(() => [{ request: { idempotency_key: 'uoa:acct_test:test:checkout:seat:19:1' },
    data: { object: { ...subscription, latest_invoice: 'in_original' } } }]);
  const provider = { subscriptions: { retrieve: async () => subscription, update }, events: { list }, invoices: { retrieve: retrieveInvoice } };
  expect(await collectAnniversarySeat(change, provider as never, nextPeriod)).toEqual({ status: 'complete', invoice: 'in_original' });
  expect(retrieveInvoice).toHaveBeenCalledWith('in_original');
  list.mockReturnValue([]);
  expect(await collectAnniversarySeat(change, provider as never, nextPeriod)).toMatchObject({ status: 'hold' });
  subscription.items.data[0].quantity = 1;
  expect(await collectAnniversarySeat(change, provider as never, nextPeriod)).toMatchObject({ reason: 'PRORATION_PERIOD_MISMATCH' });
  expect(update).not.toHaveBeenCalled();
});

function pendingChange(delta = 1): SeatPayment {
  const firstAttemptAt = new Date('2026-11-04T20:00:00Z');
  return { id: 21n, delta, fromQuantity: 2, toQuantity: 2 + delta, effectiveAt: firstAttemptAt,
    firstAttemptAt, attemptVersion: 1, stripeInvoiceId: null, checkoutId: 'checkout', account: 'acct_test',
    livemode: false, customerId: 'cus_test', subscriptionId: 'sub_test', itemId: 'si_test',
    priceId: 'price_agreed', currency: 'EUR', unitAmount: 299n };
}

function pendingProvider(status = 'active', priceId = 'price_agreed') {
  const item = { id: 'si_test', quantity: 2, current_period_start: 1793577600,
    current_period_end: 1796169600, price: { id: priceId, currency: 'eur', unit_amount: 299,
      recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } } };
  const subscription = { id: 'sub_test', customer: 'cus_test', status, livemode: false,
    metadata: { uoa_checkout_id: 'checkout', uoa_stripe_account_id: 'acct_test' },
    billing_mode: { type: 'classic' }, items: { data: [item] }, pending_update: null };
  const update = vi.fn(async (_id, params) => {
    item.quantity = params.items[0].quantity;
    return subscription;
  });
  return { subscriptions: { retrieve: async () => subscription, update }, invoices: { retrieve: vi.fn() } };
}

it('refuses a replacement Price with the same monthly amount and currency', async () => {
  const change = pendingChange();
  const provider = pendingProvider('active', 'price_unagreed');
  expect(await collectAnniversarySeat(change, provider as never, change.firstAttemptAt))
    .toEqual({ status: 'hold', reason: 'SUBSCRIPTION_BINDING' });
  expect(provider.subscriptions.update).not.toHaveBeenCalled();
});

it.each(['past_due', 'unpaid'])('reduces renewal seats during %s without crediting the unpaid period', async status => {
  const change = pendingChange(-1);
  const provider = pendingProvider(status);
  expect(await collectAnniversarySeat(change, provider as never, change.firstAttemptAt))
    .toEqual({ status: 'complete', invoice: null });
  expect(provider.subscriptions.update).toHaveBeenCalledWith('sub_test', {
    items: [{ id: 'si_test', quantity: 1 }], proration_behavior: 'none', expand: ['latest_invoice'],
  }, { idempotencyKey: 'uoa:acct_test:test:checkout:seat:21:1' });
});

it.each(['past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused', 'trialing'])(
  'refuses additional charges on a %s subscription', async status => {
    const change = pendingChange();
    const provider = pendingProvider(status);
    expect(await collectAnniversarySeat(change, provider as never, change.firstAttemptAt))
      .toEqual({ status: 'hold', reason: 'SUBSCRIPTION_PAYMENT_REQUIRED' });
    expect(provider.subscriptions.update).not.toHaveBeenCalled();
  },
);

