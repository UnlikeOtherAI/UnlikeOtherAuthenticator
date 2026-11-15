import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { hasCollectedSeatFunding } from '../../src/services/billing-anniversary-seat-funding.service.js';
import { seatCashProvider } from '../helpers/seat-cash-provider.js';

const shared = { customer: 'cus_seat', currency: 'eur', livemode: false,
  parent: { subscription_details: { subscription: 'sub_seat' } }, created: 1793822400 };
const paid = { ...shared, id: 'in_paid', status: 'paid', total: 299, amount_due: 299,
  amount_paid: 299, amount_remaining: 0, starting_balance: 0, ending_balance: 0 };
const small = { ...paid, id: 'in_small', total: 9, amount_due: 0, amount_paid: 0, ending_balance: 9 };
const renewal = { ...paid, id: 'in_renewal', amount_due: 308, amount_paid: 308, starting_balance: 9 };

function provider() {
  return { ...seatCashProvider(id => id === renewal.id ? renewal : paid),
    invoices: { list: vi.fn(async () => ({ data: [renewal], has_more: false })), retrieve: vi.fn(async () => small) },
    customers: { listBalanceTransactions: vi.fn(() => [
      { ...shared, type: 'applied_to_invoice', invoice: renewal.id, amount: -9, ending_balance: 0 },
      { ...shared, type: 'invoice_too_small', invoice: small.id, amount: 9, ending_balance: 9 },
    ]) } };
}
const funded = (invoice: unknown, stripe = provider()) => hasCollectedSeatFunding(invoice as Stripe.Invoice, 'sub_seat', stripe as never);

describe('funding an additional seat before access', () => {
  it('requires the successful cash receipt behind a fully paid invoice', async () => {
    const stripe = provider();
    expect(await funded(paid, stripe)).toBe(true);
    expect(stripe.charges.retrieve).toHaveBeenCalledOnce();
    stripe.invoicePayments.list.mockResolvedValue({ data: [], has_more: false });
    expect(await funded(paid, stripe)).toBe(false);
  });
  it.each([
    { total: 0, amount_due: 0, amount_paid: 0 },
    { amount_paid: 200, amount_remaining: 99 },
    { status: 'open' }, { ending_balance: 9 }, { total: Number.NaN },
  ])('holds incomplete or uncollected funding %#', async values => {
    expect(await funded({ ...paid, ...values })).toBe(false);
  });
  it('holds a minimum-charge carry until a later captured invoice pays that exact balance', async () => {
    const stripe = provider();
    stripe.invoices.list.mockResolvedValueOnce({ data: [], has_more: false });
    expect(await funded(small, stripe)).toBe(false);
    expect(await funded(small, stripe)).toBe(true);
    expect(stripe.invoices.retrieve).toHaveBeenCalledWith(small.id);
  });
  it('rejects a paid renewal without the exact balance-transfer chain', async () => {
    const stripe = provider();
    stripe.customers.listBalanceTransactions.mockReturnValue([]);
    expect(await funded(small, stripe)).toBe(false);
  });
  it('does not treat provider errors as payment or issue another charge', async () => {
    const stripe = provider();
    stripe.paymentIntents.retrieve.mockRejectedValue(new Error('provider unavailable'));
    await expect(funded(paid, stripe)).rejects.toThrow('provider unavailable');
  });
});
