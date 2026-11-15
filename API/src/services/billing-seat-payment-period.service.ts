import type { BillingStripePaymentInvoice, Prisma } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { hasFullSeatInvoicePayment } from './billing-seat-payment-proof.service.js';
import type { VerifiedStripeInvoiceLine } from './billing-stripe-payment-lines.service.js';

/** Preserve the financial receipt hash: paid coverage is separate immutable evidence. */
export async function recognizeSeatPaymentPeriod(tx: Prisma.TransactionClient, invoice: Stripe.Invoice,
  receipt: BillingStripePaymentInvoice, lines: VerifiedStripeInvoiceLine[]): Promise<void> {
  if (!receipt.subscriptionId || !hasFullSeatInvoicePayment(invoice)) return;
  const periods = lines.filter(line => line.seatPeriod?.subscriptionId === receipt.subscriptionId &&
    !line.carriedFromStripeInvoiceId && line.subscriptionMinor > 0n);
  if (!periods.length) return;
  await tx.$queryRaw`SELECT id FROM billing_stripe_subscriptions WHERE id=${receipt.subscriptionId} FOR UPDATE`;
  for (const line of periods) {
    if (!line.seatPeriod || line.carriedFromStripeInvoiceId || line.subscriptionMinor <= 0n) continue;
    const data = { ...line.seatPeriod, invoiceId: receipt.id, stripeLineId: line.stripeLineId };
    const prior = await tx.billingSeatPaymentPeriod.findUnique({
      where: { invoiceId_stripeLineId: { invoiceId: receipt.id, stripeLineId: line.stripeLineId } },
    });
    if (prior) {
      if (prior.subscriptionId !== data.subscriptionId || prior.startsAt.getTime() !== data.startsAt.getTime() ||
        prior.endsAt.getTime() !== data.endsAt.getTime() || prior.quantity !== data.quantity) {
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SEAT_PERIOD_SOURCE_CHANGED');
      }
    } else await tx.billingSeatPaymentPeriod.create({ data });
  }
  if (invoice.billing_reason === 'subscription_cycle') {
    await tx.billingSeatRenewalRecovery.updateMany({ where: { accountId: receipt.accountId,
      subscriptionId: receipt.subscriptionId, stripeInvoiceId: receipt.stripeInvoiceId, recoveredAt: null,
    }, data: { paymentInvoiceId: receipt.id, recoveredAt: receipt.paidAt } });
  }
}
