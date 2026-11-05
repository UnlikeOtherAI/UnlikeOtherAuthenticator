import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { netSeatProration } from '../../src/services/billing-anniversary-seat-invoice.service.js';

const service = { id: 'service', identifier: 'nessie', name: 'Nessie' };
const line = (id: string, amount: number, quantity: number, end = 1772280000) => ({
  id, amount, quantity, taxes: [], period: { start: 1771675200, end },
  pricing: { type: 'price_details', price_details: { price: 'price_seat' } },
}) as unknown as Stripe.InvoiceLineItem;

describe('Stripe classic quarter-month EUR proration', () => {
  it('records the actual 75-cent net charge and both original line references', () => {
    const offset = line('il_prior', -75, 1), charge = line('il_new', 150, 2);
    expect(netSeatProration([offset, charge], service)).toMatchObject({ stripeLineId: charge.id,
      offsetStripeLineId: offset.id, grossMinor: 75n, dueMinor: 75n, creditMinor: 0n, taxMinor: 0n });
  });
  it('requires the same period, price and a one-seat increase', () => {
    for (const offset of [line('bad_period', -75, 1, 1772279999), line('bad_quantity', -75, 0),
      { ...line('bad_price', -75, 1), pricing: null }]) {
      expect(() => netSeatProration([offset, line('charge', 150, 2)], service)).toThrow('LINES_UNPROVEN');
    }
  });
});

