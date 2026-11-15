import type Stripe from 'stripe';

/** Called only after invoice payment/charge evidence has been verified and persisted. */
export function hasFullSeatInvoicePayment(invoice: Stripe.Invoice): boolean {
  return invoice.status === 'paid' && invoice.amount_remaining === 0 && invoice.total > 0 &&
    invoice.amount_due >= invoice.total && invoice.amount_paid === invoice.amount_due &&
    (invoice.ending_balance === null || invoice.ending_balance <= 0);
}
