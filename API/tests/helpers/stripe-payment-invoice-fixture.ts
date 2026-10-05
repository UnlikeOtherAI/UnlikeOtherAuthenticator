import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { vi } from 'vitest';

const startsAt = new Date('2026-08-01T00:00:00.000Z');
const endsAt = new Date('2026-09-01T00:00:00.000Z');
const paidAt = new Date('2026-10-01T00:00:00.000Z');

export async function createStripeInvoiceFixture(prisma: PrismaClient, accountId: string, id = `in_${randomUUID().replaceAll('-', '')}`) {
    const account = await prisma.billingStripeAccount.findUniqueOrThrow({ where: { id: accountId } });
    const invoice = { id, livemode: false, status: 'paid', customer: 'cus_monthly', currency: 'usd',
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_monthly' } },
      billing_reason: 'subscription_create', amount_paid: 2000, amount_due: 2000, amount_remaining: 0,
      total: 2500, total_taxes: [{ amount: 500 }], number: `INV-${id}`,
      account_name: 'Verified seller', account_country: 'GB', customer_name: 'Verified buyer',
      customer_email: 'finance@example.test', customer_address: { country: 'GB', line1: '1 Road',
        line2: null, city: 'London', postal_code: 'SW1A 1AA', state: null },
      status_transitions: { finalized_at: endsAt.getTime() / 1000, paid_at: paidAt.getTime() / 1000 },
      effective_at: null, invoice_pdf: 'https://pay.stripe.com/invoice/test.pdf',
    };
    const paymentId = `inpay_${id}`; const intentId = `pi_${id}`; const chargeId = `ch_${id}`;
    const lines = [{ id: `il_${id}`, invoice: id, currency: 'usd', livemode: false, amount: 2500,
      parent: { type: 'subscription_item_details', subscription_item_details: {
        subscription: 'sub_monthly', subscription_item: 'si_monthly', proration: false } },
      period: { start: startsAt.getTime() / 1000, end: endsAt.getTime() / 1000 },
      discount_amounts: [], pretax_credit_amounts: [], taxes: [{ amount: 500, tax_behavior: 'inclusive' }],
    }];
    const stripe = { accounts: { retrieveCurrent: vi.fn().mockResolvedValue({ id: account.stripeAccountId }) },
      invoices: { retrieve: vi.fn().mockResolvedValue(invoice),
        listLineItems: vi.fn().mockResolvedValue({ data: lines, has_more: false }) },
      invoicePayments: { list: vi.fn().mockResolvedValue({ data: [{ id: paymentId,
        invoice: id, livemode: false, currency: 'usd', status: 'paid', amount_paid: 2000,
        payment: { type: 'payment_intent', payment_intent: intentId },
        status_transitions: { paid_at: paidAt.getTime() / 1000 } }], has_more: false }) },
      paymentIntents: { retrieve: vi.fn().mockResolvedValue({ id: intentId, latest_charge: chargeId,
        customer: 'cus_monthly', currency: 'usd', livemode: false, status: 'succeeded', amount_received: 2000 }) },
      charges: { retrieve: vi.fn().mockResolvedValue({ id: chargeId, payment_intent: intentId,
        customer: 'cus_monthly', currency: 'usd', livemode: false, status: 'succeeded',
        paid: true, captured: true, amount_captured: 2000 }) },
      subscriptions: { retrieve: vi.fn() }, webhooks: { constructEvent: vi.fn().mockReturnValue({
        id: `evt_${id}`, type: 'invoice.paid', api_version: '2026-06-24.dahlia',
        livemode: false, account: account.stripeAccountId, created: paidAt.getTime() / 1000 + 300,
        data: { object: invoice } }) },
    };
    return { account, invoice, lines, stripe: stripe as unknown as Stripe,
      intentId, paymentId, chargeId };
  }

