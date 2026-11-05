import { expect, it, vi } from 'vitest';
import { collectAnniversarySeat, type SeatPayment } from '../../src/services/billing-anniversary-seat-collection.service.js';

it('recovers a lost acknowledgement after renewal and key expiry using the exact Stripe event', async () => {
  const firstAttemptAt = new Date('2026-11-04T20:00:00Z');
  const change: SeatPayment = { id: 19n, delta: 1, fromQuantity: 1, toQuantity: 2, effectiveAt: firstAttemptAt,
    firstAttemptAt, attemptVersion: 1, stripeInvoiceId: null, checkoutId: 'checkout', account: 'acct_test',
    livemode: false, customerId: 'cus_test', subscriptionId: 'sub_test', itemId: 'si_test', currency: 'EUR', unitAmount: 299n };
  const nextPeriod = new Date('2026-11-06T00:00:00Z');
  const subscription = { id: 'sub_test', customer: 'cus_test', status: 'active', livemode: false,
    metadata: { uoa_checkout_id: 'checkout', uoa_stripe_account_id: 'acct_test' }, billing_mode: { type: 'classic' },
    latest_invoice: 'in_renewal', items: { data: [{ id: 'si_test', quantity: 2, current_period_start: +nextPeriod / 1000,
      current_period_end: +nextPeriod / 1000 + 30 * 86400, price: { currency: 'eur', unit_amount: 299,
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
