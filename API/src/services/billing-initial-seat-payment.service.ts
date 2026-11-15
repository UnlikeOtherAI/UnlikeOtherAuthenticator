import type { BillingStripePaymentInvoice, Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { hasFullSeatInvoicePayment } from './billing-seat-payment-proof.service.js';

/** Only the verified, fully collected first invoice establishes initial paid seats. */
export async function recognizeInitialSeatPayment(tx: Prisma.TransactionClient,
  invoice: Stripe.Invoice, receipt: BillingStripePaymentInvoice): Promise<void> {
  if (!receipt.subscriptionId || invoice.billing_reason !== 'subscription_create' || !hasFullSeatInvoicePayment(invoice)) return;
  await tx.billingStripeSubscription.updateMany({ where: {
    id: receipt.subscriptionId, accountId: receipt.accountId, livemode: receipt.livemode,
    orgId: receipt.orgId, teamId: receipt.teamId, initialSeatInvoiceId: null,
    tariff: { anniversarySeats: true },
  }, data: { initialSeatInvoiceId: receipt.id } });
}
