import { createHash } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { assertStripeObjectLivemode, type StripeAccountContext } from './billing-stripe-client.service.js';
import { syncBaseStripeSubscription } from './billing-stripe-subscription-projection.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';
import { stripeInvoiceMinor, stripeInvoiceCashDigest, verifyStripeInvoiceCash,
  type StripeInvoiceCashClient } from './billing-stripe-payment-evidence.service.js';
import { verifyStripePaymentInvoiceLines } from './billing-stripe-payment-lines.service.js';

type Provider = StripeInvoiceCashClient & Pick<Stripe, 'subscriptions'>;
export type PreparedStripePaymentInvoice = NonNullable<Awaited<ReturnType<typeof prepareStripePaymentInvoice>>>;

export async function prepareStripePaymentInvoice(
  invoiceId: string, account: StripeAccountContext, prisma: PrismaClient, stripe: Provider,
) {
  const invoice = await stripe.invoices.retrieve(invoiceId);
  assertStripeObjectLivemode(invoice, account.livemode);
  if (invoice.id !== invoiceId) {
    throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_INVOICE_BINDING_INVALID');
  }
  let stripeSubscriptionId = invoice.parent?.type === 'subscription_details' ?
    stripeExternalId(invoice.parent.subscription_details?.subscription ?? null) : null;
  if (!stripeSubscriptionId && invoice.parent === null) {
    const closing = await prisma.billingStripeMonthlyCharge.findFirst({ where: {
      accountId: account.id, stripeInvoiceId: invoice.id, allocationKind: 'CLOSING', state: 'ACCEPTED',
    }, include: { subscription: true } });
    if (closing && invoice.metadata?.uoa_monthly_charge_key === closing.authorityKey &&
      invoice.metadata?.uoa_monthly_subscription_id === closing.subscriptionId &&
      closing.subscription.livemode === account.livemode) {
      stripeSubscriptionId = closing.subscription.stripeSubscriptionId;
    }
  }
  if (!stripeSubscriptionId) return null;
  let subscription = await prisma.billingStripeSubscription.findUnique({
    where: { accountId_stripeSubscriptionId: { accountId: account.id, stripeSubscriptionId } },
    include: { customer: true, tariff: { select: { currency: true } } },
  });
  if (!subscription) {
    const remote = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    assertStripeObjectLivemode(remote, account.livemode);
    if (remote.id !== stripeSubscriptionId) {
      throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_INVOICE_BINDING_INVALID');
    }
    if (!remote.metadata.uoa_checkout_id) return null;
    // Out-of-order invoice.paid can arrive before subscription.created.
    // Hydrate only through the existing exact checkout/catalog binding validator.
    await prisma.$transaction((tx) => syncBaseStripeSubscription(tx, remote, account));
    subscription = await prisma.billingStripeSubscription.findUniqueOrThrow({
      where: { accountId_stripeSubscriptionId: { accountId: account.id, stripeSubscriptionId } },
      include: { customer: true, tariff: { select: { currency: true } } },
    });
  }
  if (subscription.livemode !== account.livemode ||
    subscription.tariff.currency !== invoice.currency.toUpperCase() ||
    subscription.customer.accountId !== account.id ||
    subscription.customer.orgId !== subscription.orgId ||
    subscription.customer.teamId !== subscription.teamId ||
    subscription.customer.stripeCustomerId !== stripeExternalId(invoice.customer) ||
    (invoice.status !== 'paid' && invoice.status !== 'open') ||
    stripeInvoiceMinor(invoice.amount_paid) > stripeInvoiceMinor(invoice.amount_due) ||
    stripeInvoiceMinor(invoice.amount_remaining) !==
      stripeInvoiceMinor(invoice.amount_due) - stripeInvoiceMinor(invoice.amount_paid)) {
    throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_INVOICE_PAYMENT_UNPROVEN');
  }
  if (invoice.amount_paid === 0 && invoice.amount_due === 0) return null;
  if (invoice.amount_paid <= 0) {
    throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_INVOICE_PAYMENT_UNPROVEN');
  }
  const existingPrepaid = await prisma.billingCreditPaymentInvoice.findFirst({
    where: { accountId: account.id, livemode: account.livemode, stripeInvoiceId: invoice.id },
    select: { id: true },
  });
  if (existingPrepaid) {
    throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_INVOICE_PREPAID_DUPLICATE');
  }
  const cash = await verifyStripeInvoiceCash(invoice, stripe);
  const prepaidIntent = await prisma.billingCreditPaymentInvoice.findFirst({
    where: { accountId: account.id, livemode: account.livemode,
      stripePaymentIntentId: { in: cash.payments.map((row) => row.payment_intent_id) } },
    select: { id: true },
  });
  if (prepaidIntent) {
    throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_INVOICE_PREPAID_DUPLICATE');
  }
  const lines = await verifyStripePaymentInvoiceLines({ invoice,
    accountId: account.id, subscriptionId: subscription.id,
    orgId: subscription.orgId, stripeCustomerId: subscription.customer.stripeCustomerId ?? '',
  }, prisma, stripe);
  const facts = {
    accountId: account.id, subscriptionId: subscription.id, livemode: account.livemode,
    stripeInvoiceId: invoice.id, stripeCustomerId: subscription.customer.stripeCustomerId ?? '',
    stripePaymentIntentIds: cash.payments.map((row) => row.payment_intent_id),
    paymentEvidence: cash.payments, orgId: subscription.orgId, teamId: subscription.teamId,
    paidAt: cash.paidAt, currency: invoice.currency.toUpperCase(),
    grossAmountMinor: stripeInvoiceMinor(invoice.total),
    taxAmountMinor: lines.reduce((sum, row) => sum + row.taxMinor, 0n),
    creditAmountMinor: stripeInvoiceMinor(invoice.total) - stripeInvoiceMinor(invoice.amount_due),
    dueAmountMinor: stripeInvoiceMinor(invoice.amount_due),
    paidAmountMinor: stripeInvoiceMinor(invoice.amount_paid),
  };
  // Financial invoice facts are fixed; additional verified cash payments append
  // beneath them without changing the original legal liability or source.
  const { stripePaymentIntentIds: _intents, paymentEvidence: _payments,
    paidAt: _paidAt, paidAmountMinor: _paidAmount, ...financialFacts } = facts;
  const sourceDigest = createHash('sha256').update(JSON.stringify({ facts: financialFacts,
    lines: lines.map(({ label: _label, ...line }) => line) },
    (_key, value) => typeof value === 'bigint' ? value.toString() : value)).digest('hex');
  return { facts, lines, sourceDigest, invoice };
}

export async function persistStripePaymentInvoice(
  tx: Prisma.TransactionClient, prepared: PreparedStripePaymentInvoice,
) {
  const key = { accountId_livemode_stripeInvoiceId: {
    accountId: prepared.facts.accountId, livemode: prepared.facts.livemode,
    stripeInvoiceId: prepared.facts.stripeInvoiceId,
  } };
  const row = await tx.billingStripePaymentInvoice.upsert({ where: key,
    create: { ...prepared.facts, sourceDigest: prepared.sourceDigest,
      lines: { create: prepared.lines } }, update: {}, include: { lines: true } });
  if (row.sourceDigest !== prepared.sourceDigest || row.lines.length !== prepared.lines.length) {
    throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_INVOICE_SOURCE_CHANGED');
  }
  const observed = prepared.facts.paymentEvidence.map((payment) => ({
    invoiceId: row.id, accountId: row.accountId, livemode: row.livemode,
    stripeInvoicePaymentId: payment.invoice_payment_id,
    stripePaymentIntentId: payment.payment_intent_id, stripeChargeId: payment.charge_id,
    amountMinor: BigInt(payment.amount_minor), currency: row.currency,
    paidAt: new Date(payment.paid_at), evidenceDigest: stripeInvoiceCashDigest(payment),
  }));
  const prior = await tx.billingStripePaymentInvoiceCashPayment.findMany({ where: { invoiceId: row.id } });
  if (prior.some((payment) => !observed.some((current) =>
    current.stripeInvoicePaymentId === payment.stripeInvoicePaymentId &&
    current.evidenceDigest === payment.evidenceDigest))) {
    throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_PAYMENT_HISTORY_CHANGED');
  }
  for (const payment of observed) {
    const saved = await tx.billingStripePaymentInvoiceCashPayment.upsert({
      where: { accountId_livemode_stripeInvoicePaymentId: { accountId: row.accountId,
        livemode: row.livemode, stripeInvoicePaymentId: payment.stripeInvoicePaymentId } },
      create: payment, update: {},
    });
    if (saved.invoiceId !== row.id || saved.evidenceDigest !== payment.evidenceDigest) {
      throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_PAYMENT_HISTORY_CHANGED');
    }
  }
  return row;
}
