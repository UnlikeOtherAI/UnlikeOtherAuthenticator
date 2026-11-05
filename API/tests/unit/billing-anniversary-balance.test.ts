import { describe, expect, it } from 'vitest';
import { seatBalanceSources } from '../../src/services/billing-anniversary-balance.service.js';

const shared = { customer: 'cus_seat', currency: 'eur', livemode: false };
const renewal = { ...shared, id: 'in_renew', total: 299, amount_due: 308, starting_balance: 9, ending_balance: 0 };
const small = { ...shared, id: 'in_small', total: 9, amount_due: 0, amount_paid: 0, status: 'paid',
  starting_balance: 0, ending_balance: 9, parent: { subscription_details: { subscription: 'sub_seat' } } };
const entries = [
  { ...shared, type: 'applied_to_invoice', amount: -9, ending_balance: 0, invoice: renewal.id },
  { ...shared, type: 'invoice_too_small', amount: 9, ending_balance: 9, invoice: small.id },
];
const provider = (rows = entries, prior = small) => ({
  customers: { listBalanceTransactions: () => rows }, invoices: { retrieve: async () => prior },
});
describe('Stripe minimum-charge seat carry', () => {
  it('traces a 308-cent renewal to its 299-cent renewal and the 9-cent invoice', async () => {
    await expect(seatBalanceSources(renewal as never, 'sub_seat', provider() as never)).resolves.toEqual([small]);
  });
  it('refuses other subscriptions, manual adjustments, broken chains and unmatched balances', async () => {
    for (const stripe of [provider(entries.slice(0, 1)), provider([entries[0]!, { ...entries[1]!, type: 'adjustment' }]),
      provider(entries, { ...small, total: 8 }), provider(entries, { ...small, parent: { subscription_details: { subscription: 'sub_other' } } })]) {
      await expect(seatBalanceSources(renewal as never, 'sub_seat', stripe as never)).rejects.toThrow('BALANCE_UNPROVEN');
    }
  });
});

