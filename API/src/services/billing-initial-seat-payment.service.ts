import type { BillingStripePaymentInvoice, Prisma } from '@prisma/client';
import type Stripe from 'stripe';

/** Only the verified, fully collected first invoice establishes initial paid seats. */
export async function recognizeInitialSeatPayment(tx: Prisma.TransactionClient,
  invoice: Stripe.Invoice, receipt: BillingStripePaymentInvoice): Promise<void> {
  if (!receipt.subscriptionId || invoice.billing_reason !== 'subscription_create' ||
    invoice.status !== 'paid' || invoice.amount_remaining !== 0 || invoice.total <= 0 ||
    invoice.amount_due < invoice.total || invoice.amount_paid !== invoice.amount_due ||
    invoice.ending_balance !== null && invoice.ending_balance > 0) return;
  await tx.billingStripeSubscription.updateMany({ where: {
    id: receipt.subscriptionId, accountId: receipt.accountId, livemode: receipt.livemode,
    orgId: receipt.orgId, teamId: receipt.teamId, initialSeatInvoiceId: null,
    tariff: { anniversarySeats: true },
  }, data: { initialSeatInvoiceId: receipt.id } });
}
