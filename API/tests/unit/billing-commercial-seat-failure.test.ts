import type Stripe from 'stripe';
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { prepareCommercialPayment } from '../../src/services/billing-commercial-incident.service.js';
import type { StripeAccountContext } from '../../src/services/billing-stripe-client.service.js';

const lines = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/billing-stripe-payment-lines.service.js', () => ({ verifyStripePaymentInvoiceLines: lines }));

function fixture(type: string, standalone: boolean) {
  const created = Math.floor(Date.now() / 1000) - 600;
  const original = new Date((created + 120) * 1000);
  const invoice = { id: 'in_company_seats', customer: 'cus_company', livemode: false, currency: 'eur',
    created, status: 'open', amount_due: 299, amount_remaining: 299,
    billing_reason: standalone ? 'manual' : 'subscription_cycle',
    metadata: { uoa_monthly_charge_key: 'closing-key', uoa_monthly_subscription_id: 'base' },
    parent: standalone ? null : { subscription_details: { subscription: 'sub_company' } },
  } as unknown as Stripe.Invoice;
  const event = { id: 'evt_retry', type, created: created + 300, livemode: false,
    data: { object: invoice } } as unknown as Stripe.Event;
  const charge = vi.fn(async () => ({ authorityKey: 'closing-key', subscriptionId: 'base' }));
  const local = { id: 'base', orgId: 'company', serviceId: 'nessie', scope: 'ORGANISATION', livemode: false,
    customer: { stripeCustomerId: 'cus_company' }, tariff: { currency: 'EUR' } };
  const tx = { billingCommercialIncident: { findUnique: async () => null },
    billingStripeMonthlyCharge: { findFirst: charge }, billingStripeSubscription: { findUnique: async () => local },
    billingFailureHistoryProbe: { upsert: async () => ({ complete: true, earliestFailureAt: original }) } };
  const prisma = tx as unknown as PrismaClient;
  const stripe = { invoices: { retrieve: async () => invoice }, events: { list: vi.fn() } } as unknown as Pick<Stripe, 'invoices' | 'events'>;
  const account: StripeAccountContext = { id: 'account', stripeAccountId: 'acct_company', livemode: false };
  lines.mockResolvedValue([{ serviceId: 'nessie', subscriptionMinor: 299n, amountMinor: 299n }]);
  return { invoice, event, original, charge, read: () => prepareCommercialPayment(event, account, prisma, stripe, null, null) };
}

describe('verified company seat failure sources', () => {
  it.each(['invoice.payment_failed', 'invoice.payment_action_required'])('classifies standalone closing %s without requiring a subscription invoice parent', async (type) => {
    const data = fixture(type, true);
    await expect(data.read()).resolves.toMatchObject({ category: 'seat', baseSubscriptionId: 'base',
      invoiceId: 'in_company_seats', orgId: 'company', failedAt: data.original, paid: false });
    expect(data.charge).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      stripeInvoiceId: 'in_company_seats', allocationKind: 'CLOSING', state: 'ACCEPTED' }) }));
  });
  it('recognizes recurring company seat authentication recovery through its exact subscription source', async () => {
    const data = fixture('invoice.payment_action_required', false);
    await expect(data.read()).resolves.toMatchObject({ category: 'seat', baseSubscriptionId: 'base', failedAt: data.original });
    expect(data.charge).not.toHaveBeenCalled();
  });
  it('excludes inference-only standalone debt from company downgrade', async () => {
    const data = fixture('invoice.payment_failed', true);
    lines.mockResolvedValueOnce([{ serviceId: 'nessie', subscriptionMinor: 0n, amountMinor: 299n }]);
    await expect(data.read()).resolves.toBeNull();
  });
  it('rejects changed closing authority before classifying its payment failure', async () => {
    const data = fixture('invoice.payment_failed', true);
    data.invoice.metadata.uoa_monthly_charge_key = 'another-authority';
    await expect(data.read()).rejects.toThrow('BILLING_PAYMENT_SOURCE_DRIFT');
  });
  it('does not create a new failure from a reordered notification when the exact fresh invoice is paid', async () => {
    const data = fixture('invoice.payment_failed', true); data.invoice.status = 'paid'; data.invoice.amount_remaining = 0;
    await expect(data.read()).resolves.toBeNull();
    expect(data.charge).not.toHaveBeenCalled();
  });
});
