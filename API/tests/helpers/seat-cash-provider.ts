import { vi } from 'vitest';

type PaidInvoice = { id: string; customer: string; currency: string; livemode: boolean; amount_paid: number };

/** Provider receipts for one actual capture; callers can replace any stage to exercise failure. */
export function seatCashProvider(read: (invoiceId: string) => PaidInvoice) {
  const byIntent = new Map<string, PaidInvoice>();
  return {
    invoicePayments: { list: vi.fn(async ({ invoice: invoiceId }: { invoice: string }) => {
      const invoice = read(invoiceId);
      byIntent.set('pi_' + invoice.id, invoice);
      return { has_more: false, data: [{ id: 'inpay_' + invoice.id, invoice: invoice.id,
        status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_' + invoice.id },
        amount_paid: invoice.amount_paid, currency: invoice.currency, livemode: invoice.livemode,
        status_transitions: { paid_at: 1793822400 } }] };
    }) },
    paymentIntents: { retrieve: vi.fn(async (id: string) => {
      const invoice = byIntent.get(id)!;
      return { id, status: 'succeeded', customer: invoice.customer, currency: invoice.currency,
        livemode: invoice.livemode, amount_received: invoice.amount_paid, latest_charge: 'ch_' + invoice.id };
    }) },
    charges: { retrieve: vi.fn(async (id: string) => {
      const invoice = byIntent.get('pi_' + id.slice(3))!;
      return { id, payment_intent: 'pi_' + invoice.id, customer: invoice.customer, currency: invoice.currency,
        livemode: invoice.livemode, status: 'succeeded', paid: true, captured: true, amount_captured: invoice.amount_paid };
    }) },
  };
}
