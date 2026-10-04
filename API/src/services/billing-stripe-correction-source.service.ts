import { randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { correctionDigest, correctionHold, freezeCorrectionTax } from
  './billing-stripe-correction-tax.service.js';

/** One unpaid supplement per original, with the immutable net delta frozen
 * before remote egress. Paid predecessors are separate actual invoices. */
export async function freezeStripeCorrectionSource(params: {
  closeId: string; amountMicroMinor: bigint; cursor: string;
}, prisma: PrismaClient, stripe: Pick<Stripe, 'invoices' | 'taxRates'>) {
  const close = await prisma.billingStripeInvoiceClose.findUniqueOrThrow({
    where: { id: params.closeId }, include: { subscription: { include: { customer: true, tariff: true } } } });
  const sub = close.subscription;
  if (close.state !== 'FINALIZED_HOLD' || !sub.customer.stripeCustomerId ||
    sub.accountId !== close.accountId || close.currency !== 'USD' ||
    sub.tariff.collectionMode !== 'STRIPE' || sub.tariff.usagePaymentMode !== 'PAY_AS_YOU_GO' ||
    params.amountMicroMinor <= 500_000n || !params.cursor) {
    correctionHold('STRIPE_CORRECTION_LIABILITY_UNPROVEN');
  }
  const tax = await freezeCorrectionTax({ invoiceId: close.stripeInvoiceId,
    subscriptionId: sub.id, accountId: close.accountId, orgId: sub.orgId,
    customerId: sub.customer.stripeCustomerId, serviceId: sub.serviceId,
    month: close.billingMonth, currency: close.currency, livemode: sub.livemode }, prisma, stripe);
  const amount = (params.amountMicroMinor + 500_000n) / 1_000_000n;
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    correctionHold('STRIPE_CORRECTION_AMOUNT_UNPROVEN');
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_stripe_invoice_closes
      WHERE id = ${close.id} FOR UPDATE`);
    const current = await tx.billingStripeInvoiceClose.findUniqueOrThrow({ where: { id: close.id } });
    if (current.state !== 'FINALIZED_HOLD' || current.ledgerSnapshotCursor !== params.cursor ||
      current.unbilledAmountMicroMinor !== params.amountMicroMinor) {
      correctionHold('STRIPE_CORRECTION_LIABILITY_CHANGED');
    }
    const pending = await tx.billingStripeCycleCorrection.findFirst({ where: {
      closeId: close.id, paidAt: null,
    } });
    if (pending) {
      if (pending.amountMinor > amount || pending.sourceDigest !== tax.digest) {
        correctionHold('STRIPE_CORRECTION_PENDING_SOURCE_CHANGED');
      }
      return pending;
    }
    const authorityKey = correctionDigest({ closeId: close.id,
      cursor: params.cursor, amount: amount.toString(), source: tax.digest });
    return tx.billingStripeCycleCorrection.create({ data: { id: randomUUID(),
      closeId: close.id, authorityKey, ledgerSnapshotCursor: params.cursor,
      amountMinor: amount, currency: close.currency, sourceDigest: tax.digest,
      taxPolicy: tax.policy as unknown as Prisma.InputJsonValue } });
  });
}

export function correctionMetadata(close: { id: string; stripeInvoiceId: string;
  subscriptionId: string; billingMonth: string; periodStartsAt: Date; periodEndsAt: Date },
serviceId: string, authorityKey: string) {
  return { uoa_source_close_id: close.id, uoa_source_invoice_id: close.stripeInvoiceId,
    uoa_source_subscription_id: close.subscriptionId, uoa_source_service_id: serviceId,
    uoa_source_billing_month: close.billingMonth,
    uoa_source_period_start: close.periodStartsAt.toISOString(),
    uoa_source_period_end: close.periodEndsAt.toISOString(),
    uoa_cycle_correction_key: authorityKey };
}
