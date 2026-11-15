import { describe, expect, it, vi } from 'vitest';
import { seatRenewalPaymentReason } from '../../src/services/billing-seat-renewal-reason.service.js';

const now = new Date('2026-11-15T00:00:00Z');
const invoice = { id: 'invoice', customer: 'customer', livemode: false, default_payment_method: null };
const method = { id: 'method', customer: 'customer', livemode: false, type: 'card', card: { exp_year: 2026, exp_month: 10 } };
function provider(card: unknown = method) {
  return { subscriptions: { retrieve: vi.fn().mockResolvedValue({ id: 'subscription', livemode: false,
    customer: { id: 'customer', invoice_settings: { default_payment_method: card } }, default_payment_method: null }) },
  paymentMethods: { retrieve: vi.fn().mockResolvedValue(card) } };
}
describe('seat-renewal payment diagnosis', () => {
  it('uses an exactly bound expired card, including an inherited customer default', async () => {
    expect(await seatRenewalPaymentReason(invoice as never, 'subscription', false, provider() as never, now)).toBe('card_expired');
  });
  it('does not call a current-month card expired or invent a decline', async () => {
    const stripe = provider({ ...method, card: { exp_year: 2026, exp_month: 11 } });
    expect(await seatRenewalPaymentReason(invoice as never, 'subscription', false, stripe as never, now)).toBe('payment_required');
    expect(await seatRenewalPaymentReason(invoice as never, 'subscription', true, provider(null) as never, now)).toBe('payment_action_required');
  });
  it.each([{ customer: 'another' }, { livemode: true }])('refuses foreign method evidence: %j', async change => {
    await expect(seatRenewalPaymentReason(invoice as never, 'subscription', false, provider({ ...method, ...change }) as never, now))
      .rejects.toThrow('BILLING_PAYMENT_METHOD_BINDING_UNPROVEN');
  });
});
