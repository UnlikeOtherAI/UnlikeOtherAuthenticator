import type Stripe from 'stripe';
import { AppError } from '../utils/errors.js';
import type { VerifiedStripeInvoiceLine } from './billing-stripe-payment-lines.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

function unproven(): never {
  throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_INVOICE_LINES_UNPROVEN');
}

function signed(value: number): bigint {
  if (!Number.isSafeInteger(value)) unproven();
  return BigInt(value);
}

/** Stripe classic replaces the previous quantity for the same remaining period on an increase. */
export function netSeatProration(lines: Stripe.InvoiceLineItem[], service: {
  id: string; identifier: string; name: string;
}): VerifiedStripeInvoiceLine {
  const ordered = [...lines].sort((a, b) => (b.quantity ?? -1) - (a.quantity ?? -1));
  const [charge, offset] = ordered;
  if (!charge || ordered.length > 2 || !Number.isSafeInteger(charge.quantity) || charge.quantity === null ||
    charge.quantity < 1 || charge.amount < 0 || !charge.pricing?.price_details) unproven();
  if (offset) {
    if (offset.amount > 0 || offset.quantity !== charge.quantity - 1 ||
      offset.period.start !== charge.period.start || offset.period.end !== charge.period.end ||
      stripeExternalId(offset.pricing?.price_details?.price) !== stripeExternalId(charge.pricing.price_details.price)) unproven();
  } else if (charge.quantity !== 1) unproven();
  let net = 0n; let inclusive = 0n; let tax = 0n;
  for (const line of ordered) {
    net += signed(line.amount);
    if (!line.taxes) unproven();
    for (const item of line.taxes) {
      tax += signed(item.amount);
      if (item.tax_behavior === 'inclusive') inclusive += signed(item.amount);
    }
  }
  const base = net - inclusive;
  if (base < 0n || tax < 0n || inclusive < 0n || inclusive > tax) unproven();
  return { stripeLineId: charge.id, ...(offset ? { offsetStripeLineId: offset.id } : {}), serviceId: service.id,
    serviceIdentifier: service.identifier, billingMonth: new Date(charge.period.start * 1000).toISOString().slice(0, 7),
    label: service.name + ' additional seat', subscriptionMinor: base, usageMinor: 0n, taxMinor: tax,
    creditMinor: 0n, grossMinor: base + tax, dueMinor: base + tax };
}
