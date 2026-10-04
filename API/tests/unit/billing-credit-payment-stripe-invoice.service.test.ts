import { describe, expect, it, vi } from 'vitest';

import { resolveExistingStripePaymentInvoice } from '../../src/services/billing-credit-payment-stripe-invoice.service.js';

const source = {
  id: 'payment-invoice-1',
  accountId: 'account-1',
  livemode: false,
  stripePaymentIntentId: 'pi_paid_1',
  stripeCustomerId: 'cus_paid_1',
  grossAmountMinor: 1200n,
  currency: 'GBP',
} as never;
const payment = {
  id: 'inpay_1',
  invoice: 'in_1',
  status: 'paid',
  payment: { type: 'payment_intent', payment_intent: 'pi_paid_1' },
  amount_paid: 1200,
  currency: 'gbp',
  livemode: false,
};
const invoice = {
  id: 'in_1',
  status: 'paid',
  livemode: false,
  customer: 'cus_paid_1',
  currency: 'gbp',
  total: 1200,
  amount_paid: 1200,
  amount_remaining: 0,
  number: 'ST-2026-1',
  account_name: 'Example Billing Limited',
  account_country: 'GB',
  customer_name: 'Customer Limited',
  customer_email: 'billing@customer.example',
  customer_address: {
    line1: '1 Street', city: 'London', postal_code: 'EC1 1AA', country: 'GB',
  },
  status_transitions: { finalized_at: 1_780_000_000 },
  total_taxes: [{ amount: 200 }],
  invoice_pdf: 'https://pay.stripe.com/invoice/acct_1/pdf/secret',
};

function reader(paymentRows = [payment], invoiceValue = invoice) {
  return {
    checkout: { sessions: { retrieve: vi.fn().mockResolvedValue({
      id: 'cs_1', livemode: false, mode: 'payment', status: 'complete',
      payment_status: 'paid', payment_intent: 'pi_paid_1', customer: 'cus_paid_1',
      currency: 'gbp', amount_total: 1200, invoice: 'in_1',
    }) } },
    invoicePayments: {
      list: vi.fn().mockResolvedValue({ data: paymentRows, has_more: false }),
    },
    invoices: { retrieve: vi.fn().mockResolvedValue(invoiceValue) },
  } as never;
}

describe('verified Stripe legal invoice preference', () => {
  it('uses only an exact paid provider invoice and captures its legal PDF and tax', async () => {
    const provider = reader();
    const pdf = new TextEncoder().encode('%PDF-1.7 invoice');
    const download = vi.fn().mockResolvedValue(new Response(pdf, { status: 200 }));
    const result = await resolveExistingStripePaymentInvoice(source, provider, download);
    expect(result).toMatchObject({
      invoiceId: 'in_1',
      number: 'ST-2026-1',
      taxMinor: 200n,
      accountName: 'Example Billing Limited',
    });
    expect(result?.pdf).toEqual(pdf);
    expect(provider.invoicePayments.list).toHaveBeenCalledWith({
      payment: { type: 'payment_intent', payment_intent: 'pi_paid_1' },
      limit: 2,
    });
    expect(download).toHaveBeenCalledOnce();
  });

  it('returns no provider document only when the exact intent has no invoice payment', async () => {
    const provider = reader([]);
    const download = vi.fn();
    await expect(resolveExistingStripePaymentInvoice(source, provider, download))
      .resolves.toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it('holds when Checkout confirms an invoice whose payment link has not appeared yet', async () => {
    const provider = reader([]);
    await expect(resolveExistingStripePaymentInvoice(source, provider, vi.fn(), 'cs_1'))
      .rejects.toThrow('STRIPE_PAYMENT_INVOICE_PENDING');
  });

  it('holds ambiguous payment links, mismatched amounts and unproven tax', async () => {
    await expect(resolveExistingStripePaymentInvoice(
      source, reader([payment, { ...payment, id: 'inpay_2' }]), vi.fn(),
    )).rejects.toThrow('STRIPE_PAYMENT_INVOICE_MULTIPLE_BINDINGS');
    await expect(resolveExistingStripePaymentInvoice(
      source, reader([payment], { ...invoice, amount_paid: 1100 }), vi.fn(),
    )).rejects.toThrow('STRIPE_PAYMENT_INVOICE_FACTS_INCOMPLETE');
    await expect(resolveExistingStripePaymentInvoice(
      source, reader([payment], { ...invoice, total_taxes: null }), vi.fn(),
    )).rejects.toThrow('STRIPE_PAYMENT_INVOICE_FACTS_INCOMPLETE');
  });

  it('rejects non-Stripe PDF destinations before making a network call', async () => {
    const download = vi.fn();
    await expect(resolveExistingStripePaymentInvoice(
      source, reader([payment], {
        ...invoice, invoice_pdf: 'https://attacker.example/invoice/1.pdf',
      }), download,
    )).rejects.toThrow('STRIPE_PAYMENT_INVOICE_PDF_URL_INVALID');
    expect(download).not.toHaveBeenCalled();
  });
});
