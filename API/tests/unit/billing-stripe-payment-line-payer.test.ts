import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import { verifyStripePaymentInvoiceLines } from '../../src/services/billing-stripe-payment-lines.service.js';

describe('regular invoice exact payer line binding', () => {
  const payer = { id: 'sub_local', teamId: null, customerId: 'customer_local',
    scope: 'ORGANISATION', scopeKey: 'org', livemode: false,
    stripeSubscriptionId: 'sub_stripe', stripeMonthlyItemId: 'si_monthly', stripeUsageItemId: 'si_usage',
    serviceId: 'service', service: { identifier: 'nessie', name: 'Nessie' }, tariff: { currency: 'USD' } };
  const invoice = { id: 'in_paid', total: 100, amount_due: 100, currency: 'usd', livemode: false,
    total_taxes: [] } as unknown as Stripe.Invoice;
  const line = { id: 'il_paid', invoice: invoice.id, currency: 'usd', livemode: false, amount: 100,
    parent: { type: 'subscription_item_details', subscription_item_details: {
      subscription: 'sub_other', subscription_item: 'si_other' } },
    period: { start: 1788220800, end: 1790812800 }, taxes: [], discount_amounts: [], pretax_credit_amounts: [] };
  it.each([
    { teamId: 'other_team' }, { customerId: 'other_customer' },
    { scope: 'TEAM' }, { scopeKey: 'other_org' },
  ])('rejects a line whose payer differs: %j', async (changed) => {
    const other = { ...payer, id: 'other_local', stripeSubscriptionId: 'sub_other',
      stripeMonthlyItemId: 'si_other', ...changed };
    const prisma = { billingStripeSubscription: { findMany: vi.fn().mockResolvedValue([payer, other]) },
      billingStripeMonthlyCharge: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaClient;
    const stripe = { invoices: { listLineItems: vi.fn().mockResolvedValue({ data: [line], has_more: false }) } } as unknown as Pick<Stripe, 'invoices'>;
    await expect(verifyStripePaymentInvoiceLines({ invoice, accountId: 'account',
      subscriptionId: payer.id, orgId: 'org', stripeCustomerId: 'cus_shared' }, prisma, stripe))
      .rejects.toThrow('LINES_UNPROVEN');
  });
});
