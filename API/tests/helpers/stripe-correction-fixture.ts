import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { vi } from 'vitest';

import { ids, seed } from '../integration/billing-org-responsibility.persistence.fixture.js';

export async function correctionFixture(prisma: PrismaClient) {
  await seed(prisma);
  const tariff = await prisma.billingTariff.create({ data: {
    serviceId: ids.service, key: 'correction', version: 1, name: 'Verified PAYG',
    mode: 'STANDARD', collectionMode: 'STRIPE', usagePaymentMode: 'PAY_AS_YOU_GO',
    markupBps: 3000, currency: 'USD' } });
  await prisma.billingStripeCustomer.update({ where: { id: ids.teamCustomer },
    data: { stripeCustomerId: 'cus_correction' } });
  const checkout = await prisma.billingStripeCheckoutSession.create({ data: {
    accountId: ids.account, appKeyId: ids.appKey, customerId: ids.teamCustomer,
    serviceId: ids.service, tariffId: tariff.id, tariffSource: 'SERVICE_DEFAULT',
    orgId: ids.org, teamId: ids.teamA, scope: 'TEAM', scopeKey: `${ids.org}:${ids.teamA}`,
    actorJti: randomUUID(), requestedByUserId: ids.owner, status: 'complete',
    successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64),
    leaseExpiresAt: new Date('2026-10-02T00:00:00Z'),
  } });
  const sub = await prisma.billingStripeSubscription.create({ data: {
    accountId: ids.account, customerId: ids.teamCustomer, checkoutId: checkout.id,
    serviceId: ids.service, tariffId: tariff.id, tariffSource: 'SERVICE_DEFAULT',
    orgId: ids.org, teamId: ids.teamA, scope: 'TEAM', scopeKey: `${ids.org}:${ids.teamA}`,
    stripeSubscriptionId: 'sub_correction', stripeUsageItemId: 'si_correction',
    status: 'active', livemode: false } });
  const close = await prisma.billingStripeInvoiceClose.create({ data: {
    accountId: ids.account, subscriptionId: sub.id, stripeInvoiceId: 'in_original',
    billingMonth: '2026-08', periodStartsAt: new Date('2026-08-01T00:00:00Z'),
    periodEndsAt: new Date('2026-09-01T00:00:00Z'), currency: 'USD',
    state: 'FINALIZED_HOLD', ledgerSnapshotCursor: 'bus_correction_1',
    unbilledAmountMicroMinor: 130_000_000n } });
  const buyer = { customer_name: 'Verified buyer', customer_email: 'finance@example.test',
    customer_address: { country: 'GB', line1: '1 Road', line2: null,
      city: 'London', postal_code: 'SW1A 1AA', state: null },
    customer_tax_exempt: 'none', customer_tax_ids: [] };
  const period = { start: close.periodStartsAt.getTime() / 1000, end: close.periodEndsAt.getTime() / 1000 };
  const original = { id: 'in_original', livemode: false, status: 'paid', customer: 'cus_correction',
    currency: 'usd', total: 1200, amount_due: 1200, amount_paid: 1200, amount_remaining: 0,
    total_taxes: [{ amount: 200 }], automatic_tax: { enabled: false }, default_tax_rates: [{ id: 'txr_20' }],
    default_payment_method: 'pm_original', ...buyer,
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_correction' } } };
  const originalLines = [{ id: 'il_original', invoice: original.id, livemode: false,
    currency: 'usd', amount: 1000, period, discount_amounts: [], pretax_credit_amounts: [],
    taxes: [{ amount: 200, tax_behavior: 'exclusive', tax_rate_details: { tax_rate: 'txr_20' } }],
    parent: { type: 'subscription_item_details', subscription_item_details: {
      subscription: 'sub_correction', subscription_item: 'si_correction' } } }];
  const invoices: Record<string, Stripe.Invoice> = { in_original: original as unknown as Stripe.Invoice };
  const items: Record<string, Stripe.InvoiceLineItem[]> = { in_original: originalLines as unknown as Stripe.InvoiceLineItem[] };
  const itemBehaviors: Record<string, string> = {};
  let loseInvoiceAck = false; let loseItemAck = false; let sequence = 0;
  const rate = { id: 'txr_20', livemode: false, active: true, inclusive: false,
    rate_type: 'percentage', flat_amount: null, percentage: 20, effective_percentage: 20 };
  const client = {
    accounts: { retrieveCurrent: vi.fn().mockResolvedValue({ id: 'acct_org_billing' }) },
    taxRates: { retrieve: vi.fn().mockImplementation(async () => rate) },
    invoices: {
      retrieve: vi.fn().mockImplementation(async (id: string) => invoices[id]),
      list: vi.fn().mockImplementation(async () => ({ data: Object.values(invoices).filter((row) =>
        row.id !== 'in_original'), has_more: false })),
      listLineItems: vi.fn().mockImplementation(async (id: string) => ({ data: items[id], has_more: false })),
      create: vi.fn().mockImplementation(async (params: Stripe.InvoiceCreateParams) => {
        sequence += 1; const id = `in_supp_${sequence}`;
        invoices[id] = { ...params, id, livemode: false, status: 'draft', parent: null,
          billing_reason: 'manual', total: 0, amount_due: 0, amount_paid: 0, amount_remaining: 0,
          total_taxes: [], ...buyer } as unknown as Stripe.Invoice;
        items[id] = [];
        if (loseInvoiceAck) { loseInvoiceAck = false; throw new Error('lost invoice acknowledgement'); }
        return invoices[id];
      }),
      finalizeInvoice: vi.fn().mockImplementation(async (id: string, params: { auto_advance: boolean }) => {
        const invoice = invoices[id]!; const line = items[id]![0]!;
        const behavior = itemBehaviors[id] ?? 'exclusive';
        const tax = Math.round(line.amount * (behavior === 'inclusive' ? 20 / 120 : 0.2));
        line.taxes = [{ amount: tax, tax_behavior: behavior,
          tax_rate_details: { tax_rate: 'txr_20' } }] as Stripe.InvoiceLineItem.Tax[];
        Object.assign(invoice, { status: 'open', auto_advance: params.auto_advance,
          total: line.amount + (behavior === 'inclusive' ? 0 : tax),
          amount_due: line.amount + (behavior === 'inclusive' ? 0 : tax),
          amount_remaining: line.amount + (behavior === 'inclusive' ? 0 : tax), total_taxes: [{ amount: tax }] });
        return invoice;
      }),
      update: vi.fn().mockImplementation(async (id: string, params: object) => {
        Object.assign(invoices[id]!, params); return invoices[id];
      }),
    },
    invoiceItems: { create: vi.fn().mockImplementation(async (params: Stripe.InvoiceItemCreateParams) => {
      const invoiceId = params.invoice!; const itemId = `ii_${invoiceId}`;
      itemBehaviors[invoiceId] = params.tax_behavior ?? 'exclusive';
      items[invoiceId] = [{ id: `il_${invoiceId}`, invoice: invoiceId, livemode: false,
        amount: params.amount, currency: params.currency, period: params.period,
        metadata: params.metadata, discount_amounts: [], pretax_credit_amounts: [], taxes: [],
        parent: { type: 'invoice_item_details', invoice_item_details: { invoice_item: itemId } },
      } as unknown as Stripe.InvoiceLineItem];
      if (loseItemAck) { loseItemAck = false; throw new Error('lost item acknowledgement'); }
      return { id: itemId };
    }) },
    invoicePayments: { list: vi.fn().mockImplementation(async ({ invoice: id }: { invoice: string }) => ({
      has_more: false, data: [{ id: `inpay_${id}`, invoice: id, livemode: false, currency: 'usd',
        status: 'paid', amount_paid: invoices[id]!.amount_paid,
        payment: { type: 'payment_intent', payment_intent: `pi_${id}` },
        status_transitions: { paid_at: 1791118800 } }] })) },
    paymentIntents: { retrieve: vi.fn().mockImplementation(async (id: string) => ({ id, livemode: false,
      customer: 'cus_correction', currency: 'usd', status: 'succeeded', latest_charge: `ch_${id.slice(3)}`,
      amount_received: invoices[id.slice(3)]!.amount_paid })) },
    charges: { retrieve: vi.fn().mockImplementation(async (id: string) => ({ id, livemode: false,
      customer: 'cus_correction', currency: 'usd', status: 'succeeded', payment_intent: `pi_${id.slice(3)}`,
      paid: true, captured: true, amount_captured: invoices[id.slice(3)]!.amount_paid })) },
  };
  return { close, sub, original, originalLines, rate, invoices, items, client,
    stripe: client as unknown as Stripe,
    loseInvoiceAck: () => { loseInvoiceAck = true; }, loseItemAck: () => { loseItemAck = true; },
    pay: (id: string) => { Object.assign(invoices[id]!, { status: 'paid',
      amount_paid: invoices[id]!.amount_due, amount_remaining: 0 }); } };
}
