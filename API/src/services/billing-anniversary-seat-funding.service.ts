import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { seatBalanceSources } from './billing-anniversary-balance.service.js';
import { verifyStripeInvoiceCash, type StripeInvoiceCashClient } from './billing-stripe-payment-evidence.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

type Provider = StripeInvoiceCashClient & Pick<Stripe, 'customers'>;

async function fullyCollected(invoice: Stripe.Invoice, stripe: StripeInvoiceCashClient): Promise<boolean> {
  if (invoice.status !== 'paid' || !Number.isSafeInteger(invoice.total) || invoice.total <= 0 ||
    !Number.isSafeInteger(invoice.amount_due) || invoice.amount_due < invoice.total ||
    invoice.amount_paid !== invoice.amount_due || invoice.amount_remaining !== 0 ||
    invoice.ending_balance === null || invoice.ending_balance > 0) return false;
  try {
    await verifyStripeInvoiceCash(invoice, stripe);
    return true;
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 409) return false;
    throw error;
  }
}

/** Invoice status alone also includes uncollected minimum-charge carries and manual write-offs. */
export async function hasCollectedSeatFunding(invoice: Stripe.Invoice, subscriptionId: string,
  stripe: Provider): Promise<boolean> {
  if (await fullyCollected(invoice, stripe)) return true;
  const customer = stripeExternalId(invoice.customer);
  if (!customer || invoice.status !== 'paid' || invoice.amount_paid !== 0 || invoice.amount_due !== 0 ||
    !Number.isSafeInteger(invoice.total) || invoice.total <= 0 ||
    invoice.ending_balance === null || invoice.ending_balance <= 0) return false;

  // A minimum-charge carry remains held until a later, fully collected invoice proves this
  // exact source through Stripe's balance transactions. Never charge the carried amount twice.
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const rows = await stripe.invoices.list({ customer, subscription: subscriptionId,
      status: 'paid', limit: 100, created: { gte: invoice.created },
      ...(after ? { starting_after: after } : {}) });
    for (const candidate of rows.data) {
      if (candidate.id === invoice.id || candidate.livemode !== invoice.livemode ||
        candidate.currency !== invoice.currency || stripeExternalId(candidate.customer) !== customer ||
        stripeExternalId(candidate.parent?.subscription_details?.subscription) !== subscriptionId ||
        candidate.amount_due <= candidate.total || !await fullyCollected(candidate, stripe)) continue;
      try {
        const sources = await seatBalanceSources(candidate, subscriptionId, stripe);
        if (sources.some(source => source.id === invoice.id && source.total === invoice.total)) return true;
      } catch (error) {
        if (!(error instanceof AppError && error.statusCode === 409)) throw error;
      }
    }
    if (!rows.has_more) return false;
    after = rows.data.at(-1)?.id;
    if (!after) return false;
  }
  return false;
}
