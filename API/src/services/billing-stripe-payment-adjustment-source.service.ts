import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { assertStripeObjectLivemode, type StripeAccountContext } from './billing-stripe-client.service.js';
import { disputePrincipalMovement, disputeProof } from './billing-stripe-dispute-evidence.service.js';
import { prepareStripePaymentInvoice, persistStripePaymentInvoice }
  from './billing-stripe-payment-invoice-source.service.js';
import { stripeInvoiceMinor } from './billing-stripe-payment-evidence.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

type Client = Pick<Stripe, 'refunds' | 'disputes' | 'paymentIntents' | 'charges' | 'balanceTransactions' | 'invoicePayments' | 'invoices' | 'subscriptions'>;
type Kind = 'REFUND' | 'DISPUTE' | 'DISPUTE_REVERSAL';

function evidenceTime(value: number): Date {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AppError('INTERNAL', 503, 'STRIPE_INVOICE_ADJUSTMENT_TIME_UNPROVEN');
  }
  return new Date(value * 1000);
}

async function resolveStoredCashPayment(
  intentId: string, stripe: Client, account: StripeAccountContext, prisma: PrismaClient,
) {
  const where = { accountId: account.id, livemode: account.livemode, stripePaymentIntentId: intentId };
  const stored = await prisma.billingStripePaymentInvoiceCashPayment.findFirst({ where });
  if (stored) return stored;
  // Refunds can precede invoice.paid delivery. Reverse lookup proves the original
  // payment through InvoicePayment, then the normal checkout/subscription validator.
  const payments = await stripe.invoicePayments.list({ status: 'paid', limit: 100,
    payment: { type: 'payment_intent', payment_intent: intentId } });
  if (payments.has_more) {
    throw new AppError('INTERNAL', 503, 'STRIPE_INVOICE_ADJUSTMENT_PAYMENT_SET_PENDING');
  }
  for (const payment of payments.data) {
    assertStripeObjectLivemode(payment, account.livemode);
    if (payment.status !== 'paid' || payment.payment.type !== 'payment_intent' ||
      stripeExternalId(payment.payment.payment_intent) !== intentId) {
      throw new AppError('INTERNAL', 503, 'STRIPE_INVOICE_ADJUSTMENT_PAYMENT_SET_UNPROVEN');
    }
    const invoiceId = stripeExternalId(payment.invoice);
    if (!invoiceId) throw new AppError('INTERNAL', 503, 'STRIPE_INVOICE_ADJUSTMENT_PAYMENT_SET_UNPROVEN');
    const prepared = await prepareStripePaymentInvoice(invoiceId, account, prisma, stripe);
    if (prepared) await prisma.$transaction((tx) => persistStripePaymentInvoice(tx, prepared));
  }
  return prisma.billingStripePaymentInvoiceCashPayment.findFirst({ where });
}

/** Cash effects belong to the original invoice, never to its prepaid wallet. */
export async function prepareStripePaymentAdjustment(
  event: Stripe.Event, stripe: Client, account: StripeAccountContext, prisma: PrismaClient,
) {
  let kind: Kind; let objectId: string; let intentId: string | null; let chargeId: string | null;
  let amount: number; let currency: string; let occurredAt: Date; let effectProof: string;
  let priorWithdrawal: { amount: number; at: Date; proof: string } | null = null;
  if (event.type === 'refund.created' || event.type === 'refund.updated' || event.type === 'refund.failed') {
    const signed = event.data.object as Stripe.Refund;
    const refund = await stripe.refunds.retrieve(signed.id);
    assertStripeObjectLivemode(refund, account.livemode);
    if (refund.id !== signed.id || refund.amount !== signed.amount || refund.currency !== signed.currency ||
      stripeExternalId(refund.payment_intent) !== stripeExternalId(signed.payment_intent) ||
      stripeExternalId(refund.charge) !== stripeExternalId(signed.charge)) {
      throw new AppError('INTERNAL', 503, 'STRIPE_INVOICE_ADJUSTMENT_STATE_DRIFT');
    }
    if (signed.status !== refund.status || refund.status !== 'succeeded') return null;
    intentId = stripeExternalId(refund.payment_intent); chargeId = stripeExternalId(refund.charge);
    if (!intentId || !chargeId) return null;
    // An unrelated refund needs no commercial source or provider queries.
    const stored = await resolveStoredCashPayment(intentId, stripe, account, prisma);
    if (!stored) return null;
    const balanceId = stripeExternalId(refund.balance_transaction);
    if (!balanceId) throw new AppError('INTERNAL', 503, 'STRIPE_INVOICE_REFUND_CASH_PENDING');
    const balance = await stripe.balanceTransactions.retrieve(balanceId);
    if (balance.id !== balanceId || stripeExternalId(balance.source) !== refund.id || balance.amount >= 0) {
      throw new AppError('INTERNAL', 503, 'STRIPE_INVOICE_REFUND_CASH_UNPROVEN');
    }
    kind = 'REFUND'; objectId = refund.id; amount = refund.amount; currency = refund.currency;
    occurredAt = evidenceTime(balance.created);
    effectProof = JSON.stringify([balance.id, balance.amount, balance.currency,
      balance.exchange_rate, balance.created, stripeExternalId(balance.source)]);
  } else if (event.type === 'charge.dispute.funds_withdrawn' ||
    event.type === 'charge.dispute.funds_reinstated') {
    const signed = event.data.object as Stripe.Dispute;
    const dispute = await stripe.disputes.retrieve(signed.id);
    assertStripeObjectLivemode(dispute, account.livemode);
    if (dispute.id !== signed.id || dispute.amount !== signed.amount || dispute.currency !== signed.currency ||
      stripeExternalId(dispute.payment_intent) !== stripeExternalId(signed.payment_intent) ||
      stripeExternalId(dispute.charge) !== stripeExternalId(signed.charge)) {
      throw new AppError('INTERNAL', 503, 'STRIPE_INVOICE_ADJUSTMENT_STATE_DRIFT');
    }
    if (disputeProof(signed) !== disputeProof(dispute)) return null;
    intentId = stripeExternalId(dispute.payment_intent); chargeId = stripeExternalId(dispute.charge);
    if (!intentId || !chargeId) return null;
    const stored = await resolveStoredCashPayment(intentId, stripe, account, prisma);
    if (!stored) return null;
    const reinstated = event.type === 'charge.dispute.funds_reinstated';
    amount = disputePrincipalMovement(dispute, reinstated);
    const movements = dispute.balance_transactions.filter((row) => reinstated ? row.amount > 0 : row.amount < 0);
    occurredAt = evidenceTime(Math.min(...movements.map((row) => row.created)));
    kind = reinstated ? 'DISPUTE_REVERSAL' : 'DISPUTE'; objectId = dispute.id; currency = dispute.currency;
    effectProof = disputeProof({ ...dispute, balance_transactions: movements });
    if (reinstated) {
      const withdrawals = dispute.balance_transactions.filter((row) => row.amount < 0);
      priorWithdrawal = { amount: disputePrincipalMovement(dispute, false),
        at: evidenceTime(Math.min(...withdrawals.map((row) => row.created))),
        proof: disputeProof({ ...dispute, balance_transactions: withdrawals }) };
    }
  } else return null;

  const payment = await prisma.billingStripePaymentInvoiceCashPayment.findFirst({ where: {
    accountId: account.id, livemode: account.livemode, stripePaymentIntentId: intentId,
  }, include: { invoice: true } });
  if (!payment) return null;
  const amountMinor = stripeInvoiceMinor(amount);
  const intent = await stripe.paymentIntents.retrieve(intentId);
  const charge = await stripe.charges.retrieve(chargeId);
  assertStripeObjectLivemode(intent, account.livemode);
  assertStripeObjectLivemode(charge, account.livemode);
  if (amountMinor <= 0n || amountMinor > payment.amountMinor ||
    payment.currency !== currency.toUpperCase() || payment.stripeChargeId !== chargeId ||
    intent.id !== intentId || intent.status !== 'succeeded' ||
    stripeExternalId(intent.customer) !== payment.invoice.stripeCustomerId ||
    intent.currency.toUpperCase() !== payment.currency ||
    stripeInvoiceMinor(intent.amount_received) !== payment.amountMinor ||
    stripeExternalId(intent.latest_charge) !== chargeId || charge.id !== chargeId ||
    stripeExternalId(charge.payment_intent) !== intentId ||
    stripeExternalId(charge.customer) !== payment.invoice.stripeCustomerId ||
    charge.currency.toUpperCase() !== payment.currency || charge.status !== 'succeeded' ||
    !charge.paid || !charge.captured || stripeInvoiceMinor(charge.amount_captured) !== payment.amountMinor) {
    throw new AppError('INTERNAL', 503, 'STRIPE_INVOICE_ADJUSTMENT_BINDING_UNPROVEN');
  }
  const boundIntentId = intentId; const boundChargeId = chargeId;
  const effect = (effectKind: Kind, minor: bigint, at: Date, proof: string) => {
    const facts = { invoiceId: payment.invoiceId, stripePaymentIntentId: boundIntentId,
      stripeChargeId: boundChargeId, kind: effectKind, stripeObjectId: objectId, amountMinor: minor,
      currency: payment.currency, occurredAt: at, stripeEventId: event.id };
    const evidenceDigest = createHash('sha256').update(JSON.stringify([
      account.id, account.livemode, payment.evidenceDigest, effectKind, objectId,
      minor.toString(), payment.currency, at.toISOString(), proof,
    ])).digest('hex');
    return { ...facts, evidenceDigest };
  };
  // A reinstatement may arrive first. Its verified current movement set also
  // proves the original withdrawal, so persist both effects atomically.
  const withdrawal = priorWithdrawal
    ? effect('DISPUTE', stripeInvoiceMinor(priorWithdrawal.amount), priorWithdrawal.at, priorWithdrawal.proof) : null;
  return { ...effect(kind, amountMinor, occurredAt, effectProof), withdrawal };

}

export type PreparedStripePaymentAdjustment = NonNullable<Awaited<ReturnType<typeof prepareStripePaymentAdjustment>>>;

export async function persistStripePaymentAdjustment(
  tx: Prisma.TransactionClient, prepared: Omit<PreparedStripePaymentAdjustment, 'withdrawal'> &
    { withdrawal?: PreparedStripePaymentAdjustment['withdrawal'] },
) {
  // Serialize cumulative cash effects with invoice/cash-source writes.
  await tx.$queryRaw`SELECT id FROM billing_stripe_payment_invoices
    WHERE id = ${prepared.invoiceId} FOR UPDATE`;
  if (prepared.withdrawal) await persistStripePaymentAdjustment(tx, prepared.withdrawal);
  const key = { invoiceId_kind_stripeObjectId: { invoiceId: prepared.invoiceId,
    kind: prepared.kind, stripeObjectId: prepared.stripeObjectId } };
  const existing = await tx.billingStripePaymentInvoiceAdjustment.findUnique({ where: key });
  if (existing) {
    if (existing.evidenceDigest !== prepared.evidenceDigest) {
      throw new AppError('INTERNAL', 503, 'STRIPE_INVOICE_ADJUSTMENT_HISTORY_CHANGED');
    }
    return existing;
  }
  const payment = await tx.billingStripePaymentInvoiceCashPayment.findFirstOrThrow({ where: {
    invoiceId: prepared.invoiceId, stripePaymentIntentId: prepared.stripePaymentIntentId,
    stripeChargeId: prepared.stripeChargeId, currency: prepared.currency,
  } });
  if (prepared.amountMinor > payment.amountMinor) {
    throw new AppError('INTERNAL', 503, 'STRIPE_INVOICE_ADJUSTMENT_AMOUNT_UNPROVEN');
  }
  if (prepared.kind === 'REFUND') {
    const previous = await tx.billingStripePaymentInvoiceAdjustment.aggregate({ where: {
      invoiceId: prepared.invoiceId, stripePaymentIntentId: prepared.stripePaymentIntentId, kind: 'REFUND',
    }, _sum: { amountMinor: true } });
    if ((previous._sum.amountMinor ?? 0n) + prepared.amountMinor > payment.amountMinor) {
      throw new AppError('INTERNAL', 503, 'STRIPE_INVOICE_REFUND_TOTAL_UNPROVEN');
    }
  }
  const { withdrawal: _withdrawal, ...data } = prepared;
  return tx.billingStripePaymentInvoiceAdjustment.create({ data });
}
