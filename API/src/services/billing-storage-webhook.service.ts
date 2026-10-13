import type { Prisma, PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { AppError } from '../utils/errors.js';
import type { StripeAccountContext } from './billing-stripe-client.service.js';
import { verifyStorageSetup } from './billing-storage-mandate.service.js';
import { storageBinding, assertStorageSubscription, readBoundStorageInvoice } from './billing-storage-invoice.service.js';
import { verifyStripeInvoiceCash } from './billing-stripe-payment-evidence.service.js';
import { firstFailure, applyCommercialPayment, type PreparedCommercialPayment } from './billing-commercial-incident.service.js';

type StorageBinding = NonNullable<Awaited<ReturnType<typeof storageBinding>>>;
export type PreparedStorageWebhook =
  | { kind: 'mandate'; mandateId: string; checkoutId: string; setupId: string; paymentMethodId: string }
  | { kind: 'subscription'; binding: StorageBinding; remote: Stripe.Subscription }
  | { kind: 'invoice'; binding: StorageBinding; remote: Stripe.Subscription; invoice: Stripe.Invoice;
      payment: PreparedCommercialPayment | null; paidAt: Date | null; cashEvidence: Prisma.InputJsonValue | null };

export async function prepareStorageWebhook(event: Stripe.Event, stripe: Stripe,
  account: StripeAccountContext, prisma: PrismaClient): Promise<PreparedStorageWebhook | null> {
  if (event.type === 'checkout.session.completed') {
    const signed = event.data.object as Stripe.Checkout.Session;
    const id = signed.metadata?.uoa_storage_mandate_id;
    if (!id || signed.mode !== 'setup') return null;
    const mandate = await prisma.billingStorageMandate.findUnique({ where: { id } });
    if (!mandate || mandate.accountId !== account.id || mandate.revokedAt ||
      (mandate.stripeCheckoutId && mandate.stripeCheckoutId !== signed.id)) {
      throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_MANDATE_BINDING_INVALID');
    }
    const proof = await verifyStorageSetup({ ...mandate, stripeCheckoutId: signed.id }, stripe, account.livemode);
    if (!proof) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_SETUP_UNPROVEN');
    return { kind: 'mandate', mandateId: mandate.id, checkoutId: signed.id, ...proof };
  }
  if (event.type.startsWith('customer.subscription.')) {
    const signed = event.data.object as Stripe.Subscription;
    const binding = await storageBinding(signed.metadata, account, prisma);
    if (!binding) return null;
    const remote = await stripe.subscriptions.retrieve(signed.id);
    assertStorageSubscription(binding, remote, account);
    return { kind: 'subscription', binding, remote };
  }
  if (!event.type.startsWith('invoice.')) return null;
  const signed = event.data.object as Stripe.Invoice;
  const binding = await storageBinding(signed.parent?.subscription_details?.metadata, account, prisma);
  if (!binding) return null;
  const { invoice, remote } = await readBoundStorageInvoice(signed.id, stripe, account, prisma, binding);
  let paidAt: Date | null = null;
  let cashEvidence: Prisma.InputJsonValue | null = null;
  let payment: PreparedCommercialPayment | null = null;
  if (event.type === 'invoice.paid') {
    if (invoice.status !== 'paid' || invoice.amount_remaining !== 0 || invoice.amount_paid !== invoice.amount_due) {
      throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_PAYMENT_UNPROVEN');
    }
    const cash = await verifyStripeInvoiceCash(invoice, stripe);
    paidAt = cash.paidAt; cashEvidence = cash.payments;
    payment = { serviceId: binding.expansion.serviceId, orgId: binding.expansion.orgId, category: 'storage',
      accountId: account.id, invoiceId: invoice.id, storageExpansionId: binding.expansion.id, paid: true, failedAt: paidAt };
  } else if (['invoice.payment_failed', 'invoice.payment_action_required'].includes(event.type) &&
    invoice.status === 'open' && invoice.amount_remaining > 0) {
    payment = { serviceId: binding.expansion.serviceId, orgId: binding.expansion.orgId, category: 'storage',
      accountId: account.id, invoiceId: invoice.id, storageExpansionId: binding.expansion.id, paid: false,
      failedAt: await firstFailure(invoice, event, stripe, prisma, account.id) };
  }
  return { kind: 'invoice', binding, remote, invoice, payment, paidAt, cashEvidence };
}

export async function applyStorageWebhook(tx: Prisma.TransactionClient, prepared: PreparedStorageWebhook,
  webhookEventId: string, now = new Date()) {
  if (prepared.kind === 'mandate') {
    await tx.billingStorageMandate.updateMany({ where: { id: prepared.mandateId, revokedAt: null,
      state: { in: ['creating', 'open'] } }, data: { state: 'accepted', acceptedAt: now,
      stripeCheckoutId: prepared.checkoutId, stripeSetupIntentId: prepared.setupId,
      stripePaymentMethodId: prepared.paymentMethodId } });
    return;
  }
  const { binding, remote } = prepared;
  await tx.$queryRaw`SELECT id FROM organisations WHERE id=${binding.expansion.orgId} FOR UPDATE`;
  await tx.billingStoragePaymentAttempt.updateMany({ where: { id: binding.attempt.id }, data: {
    stripeSubscriptionId: remote.id, ...(prepared.kind === 'invoice' ? { stripeInvoiceId: prepared.invoice.id } : {}),
  } });
  const item = remote.items.data[0]!;
  const existing = await tx.billingStorageSubscription.findUnique({ where: { serviceId_orgId_accountId: {
    serviceId: binding.expansion.serviceId, orgId: binding.expansion.orgId, accountId: binding.mandate.accountId,
  } } });
  if (!existing) {
    const created = await tx.billingStorageSubscription.create({ data: { serviceId: binding.expansion.serviceId,
      orgId: binding.expansion.orgId, accountId: binding.mandate.accountId, mandateId: binding.mandate.id,
      catalogId: binding.catalog.id, stripeSubscriptionId: remote.id, stripeItemId: item.id,
      purchasedBlocks: 0, pendingBlocks: binding.expansion.toBlocks, state: remote.status,
      currentPeriodStart: new Date(item.current_period_start * 1000), currentPeriodEnd: new Date(item.current_period_end * 1000) } });
    await tx.billingStorageExpansion.update({ where: { id: binding.expansion.id }, data: { subscriptionId: created.id } });
  }
  await tx.billingStorageSubscription.updateMany({ where: { serviceId: binding.expansion.serviceId,
    orgId: binding.expansion.orgId, stripeSubscriptionId: remote.id }, data: { state: remote.status,
    currentPeriodStart: new Date(remote.items.data[0]!.current_period_start * 1000),
    currentPeriodEnd: new Date(remote.items.data[0]!.current_period_end * 1000) } });
  if (prepared.kind !== 'invoice') return;
  if (prepared.payment) {
    const original = !prepared.payment.paid && prepared.invoice.billing_reason !== 'subscription_cycle'
      ? await tx.billingCommercialIncident.findFirst({ where: { storageExpansionId: binding.expansion.id,
        resolvedAt: null }, orderBy: { graceEndsAt: 'asc' } }) : null;
    if (!original) await applyCommercialPayment(tx, prepared.payment, webhookEventId, now);
  }
  if (prepared.paidAt) {
    await tx.billingStoragePaymentEvidence.upsert({ where: { accountId_invoiceId: {
      accountId: binding.mandate.accountId, invoiceId: prepared.invoice.id,
    } }, create: { accountId: binding.mandate.accountId, invoiceId: prepared.invoice.id,
      attemptId: binding.attempt.id, webhookEventId, currency: prepared.invoice.currency.toUpperCase(),
      amountMinor: BigInt(prepared.invoice.amount_paid), cashEvidence: prepared.cashEvidence!, paidAt: prepared.paidAt,
    }, update: {} });
    const attempt = await tx.billingStoragePaymentAttempt.findFirst({ where: { expansionId: binding.expansion.id }, orderBy: { generation: 'desc' } });
    if (attempt?.id !== binding.attempt.id) return;
    await tx.billingStorageExpansion.updateMany({ where: { id: binding.expansion.id, state: { not: 'paid' } },
      data: { state: 'paid', paymentProvenAt: prepared.paidAt } });
    const current = await tx.billingStorageSubscription.findFirst({ where: { serviceId: binding.expansion.serviceId,
      orgId: binding.expansion.orgId, stripeSubscriptionId: remote.id } });
    if (current) {
      const purchasedBlocks = Math.max(current.purchasedBlocks, binding.expansion.toBlocks);
      await tx.billingStorageSubscription.update({ where: { id: current.id }, data: { purchasedBlocks,
        pendingBlocks: current.pendingBlocks <= purchasedBlocks ? 0 : current.pendingBlocks } });
    }
    // Replacement pays the same logical purchase; terminal prior debt remains
    // history but cannot keep the company restricted after this exact cash proof.
    const priorAttempts = await tx.billingStoragePaymentAttempt.findMany({ where: { expansionId: binding.expansion.id,
      generation: { lt: binding.attempt.generation }, terminalUnpaidProvenAt: { not: null }, stripeInvoiceId: { not: null } } });
    const old = await tx.billingCommercialIncident.findMany({ where: { storageExpansionId: binding.expansion.id,
      invoiceId: { in: priorAttempts.map((row) => row.stripeInvoiceId!) }, resolvedAt: null } });
    for (const incident of old) {
      await tx.billingCommercialIncident.update({ where: { id: incident.id }, data: { resolvedAt: now, resolutionEventId: webhookEventId } });
      await tx.billingCommercialNotification.upsert({ where: { incidentId_stage: { incidentId: incident.id, stage: 'resolved' } },
        create: { incidentId: incident.id, stage: 'resolved', dueAt: now }, update: {} });
    }
  }
}
