import { describe, expect, it, vi } from 'vitest';
import { recognizeInitialSeatPayment } from '../../src/services/billing-initial-seat-payment.service.js';

const invoice = { billing_reason: 'subscription_create', status: 'paid', total: 399,
  amount_due: 399, amount_paid: 399, amount_remaining: 0, ending_balance: 0 };
const receipt = { id: 'receipt', subscriptionId: 'sub', accountId: 'acct', livemode: false, orgId: 'org', teamId: null };
describe('initial collected seat payment', () => {
  it('binds one verified receipt to the exact subscription and scope', async () => {
    const updateMany = vi.fn();
    await recognizeInitialSeatPayment({ billingStripeSubscription: { updateMany } } as never, invoice as never, receipt as never);
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({ where: { id: 'sub', accountId: 'acct', livemode: false,
      orgId: 'org', teamId: null, initialSeatInvoiceId: null, tariff: { anniversarySeats: true } },
    data: { initialSeatInvoiceId: 'receipt' } });
  });
  it.each([{ status: 'open' }, { billing_reason: 'subscription_update' }, { amount_paid: 0 },
    { amount_due: 0, amount_paid: 0, ending_balance: 399 }, { amount_remaining: 1 },
    { total: 0, amount_due: 0, amount_paid: 0 }, { ending_balance: 1 }])('keeps incomplete funding held: %j', async change => {
    const updateMany = vi.fn();
    await recognizeInitialSeatPayment({ billingStripeSubscription: { updateMany } } as never,
      { ...invoice, ...change } as never, receipt as never);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
