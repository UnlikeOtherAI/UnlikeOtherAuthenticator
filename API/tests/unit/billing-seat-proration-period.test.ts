import { describe, expect, it, vi } from 'vitest';
import { verifyStripePaymentInvoiceLines } from '../../src/services/billing-stripe-payment-lines.service.js';

describe('additional seat coverage', () => {
  it('retains the exact remaining period and one additional seat after netting the prior quantity', async () => {
    const payer = { id: 'sub_local', teamId: null, customerId: 'customer_local',
      scope: 'ORGANISATION', scopeKey: 'org', livemode: false,
      stripeSubscriptionId: 'sub_stripe', stripeMonthlyItemId: 'si_monthly', stripeUsageItemId: 'si_usage',
      serviceId: 'service', service: { id: 'service', identifier: 'nessie', name: 'Nessie' },
      tariff: { currency: 'USD', anniversarySeats: true } };
    const invoice = { id: 'in_paid', total: 75, amount_due: 75, currency: 'usd', livemode: false,
      total_taxes: [], billing_reason: 'subscription_update' };
    const base = { invoice: invoice.id, currency: 'usd', livemode: false,
      parent: { type: 'subscription_item_details', subscription_item_details: {
        subscription: payer.stripeSubscriptionId, subscription_item: payer.stripeMonthlyItemId, proration: true } },
      period: { start: 1788220800, end: 1790812800 }, taxes: [], discount_amounts: [], pretax_credit_amounts: [],
      pricing: { type: 'price_details', price_details: { price: 'price_seat' } } };
    const prisma = { billingStripeSubscription: { findMany: vi.fn().mockResolvedValue([payer]) },
      billingStripeInvoiceCloseResolution: { findMany: vi.fn().mockResolvedValue([]) },
      billingStripeMonthlyCharge: { findMany: vi.fn().mockResolvedValue([]) } };
    const stripe = { invoices: { listLineItems: vi.fn().mockResolvedValue({ has_more: false, data: [
      { ...base, id: 'il_old', quantity: 1, amount: -75 }, { ...base, id: 'il_new', quantity: 2, amount: 150 },
    ] }) } };
    expect(await verifyStripePaymentInvoiceLines({ invoice: invoice as never, accountId: 'account',
      subscriptionId: payer.id, orgId: 'org', stripeCustomerId: 'cus_shared' }, prisma as never, stripe as never))
      .toEqual([expect.objectContaining({ dueMinor: 75n, stripeLineId: 'il_new', offsetStripeLineId: 'il_old',
        seatPeriod: { subscriptionId: payer.id, startsAt: new Date(base.period.start * 1000),
          endsAt: new Date(base.period.end * 1000), quantity: 1 } })]);
  });
});
