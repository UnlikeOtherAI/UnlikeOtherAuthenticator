import type Stripe from 'stripe';
import { AppError } from '../utils/errors.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

function unproven(): never {
  throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_BALANCE_UNPROVEN');
}

/** Reconstruct a Stripe minimum-charge carry from its customer balance transactions. */
export async function seatBalanceSources(invoice: Stripe.Invoice, subscriptionId: string,
  stripe: Pick<Stripe, 'customers' | 'invoices'>): Promise<Stripe.Invoice[]> {
  const customer = stripeExternalId(invoice.customer);
  const extra = invoice.amount_due - invoice.total;
  if (!customer || !Number.isSafeInteger(extra) || extra <= 0 || invoice.ending_balance !== 0 ||
    invoice.starting_balance !== extra) unproven();
  let found = false, remaining = extra, inspected = 0;
  const sources: Stripe.Invoice[] = [];
  const seen = new Set<string>();
  for await (const entry of stripe.customers.listBalanceTransactions(customer, { limit: 100 })) {
    if (++inspected > 1000) unproven();
    if (entry.currency !== invoice.currency) continue;
    if (entry.livemode !== invoice.livemode || stripeExternalId(entry.customer) !== customer) unproven();
    const sourceId = stripeExternalId(entry.invoice);
    if (!found) {
      if (sourceId !== invoice.id) continue;
      if (entry.type !== 'applied_to_invoice' || entry.amount !== -extra || entry.ending_balance !== 0) unproven();
      found = true;
      continue;
    }
    if (entry.type !== 'invoice_too_small' || entry.ending_balance !== remaining ||
      !Number.isSafeInteger(entry.amount) || entry.amount <= 0 || entry.amount > remaining ||
      !sourceId || seen.has(sourceId)) unproven();
    const source = await stripe.invoices.retrieve(sourceId);
    if (source.id !== sourceId || source.status !== 'paid' || source.livemode !== invoice.livemode ||
      source.currency !== invoice.currency || stripeExternalId(source.customer) !== customer ||
      stripeExternalId(source.parent?.subscription_details?.subscription) !== subscriptionId ||
      source.total !== entry.amount || source.amount_paid !== 0 || source.amount_due !== 0 ||
      source.ending_balance !== remaining || source.starting_balance !== remaining - entry.amount) unproven();
    sources.push(source);
    seen.add(sourceId);
    remaining -= entry.amount;
    if (remaining === 0) return sources;
  }
  return unproven();
}
