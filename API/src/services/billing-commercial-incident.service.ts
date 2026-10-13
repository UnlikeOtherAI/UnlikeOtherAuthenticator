import type { Prisma, PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { AppError } from '../utils/errors.js';
import { weekdayGraceDeadline } from './billing-commercial-clock.service.js';
import { assertStripeObjectLivemode, type StripeAccountContext } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';
import { verifyStripePaymentInvoiceLines } from './billing-stripe-payment-lines.service.js';
import type { PreparedRecurringAddonWebhook } from './billing-recurring-addon-webhook.service.js';

export type PreparedCommercialPayment = {
  serviceId: string; orgId: string; category: 'seat' | 'storage' | 'phone' | 'addon';
  accountId: string; invoiceId: string; failedAt: Date; paid: boolean;
  baseSubscriptionId?: string; addonSubscriptionId?: string; storageExpansionId?: string;
  resourceId?: string;
};

/** Stripe retries cannot invent a later start: find the first original failure. */
export async function firstFailure(invoice: Stripe.Invoice, event: Stripe.Event,
  stripe: Pick<Stripe, 'events'>, prisma: PrismaClient, accountId: string): Promise<Date> {
  const old = await prisma.billingCommercialIncident.findUnique({ where: {
    accountId_invoiceId: { accountId, invoiceId: invoice.id },
  } });
  if (old) return old.failedAt;
  if (invoice.created * 1000 < Date.now() - 30 * 86_400_000) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_FAILURE_HISTORY_EXPIRED');
  }
  const identity = { accountId, invoiceId: invoice.id };
  const probe = await prisma.billingFailureHistoryProbe.upsert({ where: { accountId_invoiceId: identity },
    create: { ...identity, earliestFailureAt: new Date(event.created * 1000) }, update: {} });
  if (probe.complete) return probe.earliestFailureAt;
  // One bounded page per delivery, with committed progress. Unrelated failures
  // cannot trap the same invoice forever at a fixed account-wide scan ceiling.
  const events = await stripe.events.list({ type: 'invoice.payment_failed', limit: 100,
    created: { gte: invoice.created }, ...(probe.cursor ? { starting_after: probe.cursor } : {}) });
  let earliest = probe.earliestFailureAt.getTime();
  for (const candidate of events.data) {
    const failed = candidate.data.object as Stripe.Invoice;
    if (failed.id === invoice.id && candidate.livemode === event.livemode) {
      earliest = Math.min(earliest, candidate.created * 1000);
    }
  }
  const cursor = events.data.at(-1)?.id ?? probe.cursor;
  if (events.has_more && cursor === probe.cursor) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_FAILURE_HISTORY_UNRESOLVED');
  }
  await prisma.billingFailureHistoryProbe.updateMany({ where: { ...identity, generation: probe.generation },
    data: { cursor, earliestFailureAt: new Date(earliest), complete: !events.has_more, generation: { increment: 1 } } });
  const current = await prisma.billingFailureHistoryProbe.findUniqueOrThrow({ where: { accountId_invoiceId: identity } });
  if (!current.complete) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_FAILURE_HISTORY_CONTINUING');
  return current.earliestFailureAt;
}

export async function prepareCommercialPayment(event: Stripe.Event, account: StripeAccountContext,
  prisma: PrismaClient, stripe: Pick<Stripe, 'invoices' | 'events'>,
  addon: PreparedRecurringAddonWebhook | null, paidBaseInvoiceId: string | null,
): Promise<PreparedCommercialPayment | null> {
  if (!['invoice.payment_failed', 'invoice.paid'].includes(event.type)) return null;
  const signed = event.data.object as Stripe.Invoice;
  const invoice = addon && 'invoice' in addon ? addon.invoice : await stripe.invoices.retrieve(signed.id);
  assertStripeObjectLivemode(invoice, account.livemode);
  if (invoice.id !== signed.id || stripeExternalId(invoice.customer) !== stripeExternalId(signed.customer)) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_PAYMENT_SOURCE_DRIFT');
  }
  // A delayed failure that is already paid never creates a new incident.
  if (event.type === 'invoice.payment_failed' && invoice.status === 'paid') return null;
  const paid = event.type === 'invoice.paid';
  if (!paid && (invoice.status !== 'open' || invoice.amount_remaining <= 0)) return null;
  if (!['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason ?? '')) return null;
  if (addon && 'local' in addon && 'invoice' in addon) {
    if (paid && !['invoice_paid', 'invoice_renewal'].includes(addon.kind)) return null;
    const resource = await prisma.billingSmsNumberResource.findFirst({ where: {
      serviceId: addon.local.serviceId, orgId: addon.local.orgId, offerId: addon.local.offerId,
    } });
    return { serviceId: addon.local.serviceId, orgId: addon.local.orgId,
      category: resource ? 'phone' : 'addon', accountId: account.id, invoiceId: invoice.id,
      addonSubscriptionId: addon.local.id, ...(resource ? { resourceId: resource.id } : {}),
      failedAt: paid ? new Date(event.created * 1000) : await firstFailure(invoice, event, stripe, prisma, account.id), paid };
  }
  const subscriptionId = stripeExternalId(invoice.parent?.subscription_details?.subscription);
  if (!subscriptionId) return null;
  const local = await prisma.billingStripeSubscription.findUnique({ where: {
    accountId_stripeSubscriptionId: { accountId: account.id, stripeSubscriptionId: subscriptionId },
  }, include: { customer: true, tariff: true } });
  if (!local || local.scope !== 'ORGANISATION') return null;
  if (local.customer.stripeCustomerId !== stripeExternalId(invoice.customer) ||
    local.tariff.currency !== invoice.currency.toUpperCase() || local.livemode !== account.livemode) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_PAYMENT_SOURCE_DRIFT');
  }
  const lines = await verifyStripePaymentInvoiceLines({ invoice, accountId: account.id,
    subscriptionId: local.id, orgId: local.orgId, stripeCustomerId: local.customer.stripeCustomerId ?? '' }, prisma, stripe);
  // An inference-only invoice is not a seat failure and must not downgrade a company.
  if (!lines.some((line) => line.serviceId === local.serviceId && line.subscriptionMinor > 0n)) return null;
  if (paid && paidBaseInvoiceId !== invoice.id) return null;
  return { serviceId: local.serviceId, orgId: local.orgId, category: 'seat', accountId: account.id,
    invoiceId: invoice.id, baseSubscriptionId: local.id,
    failedAt: paid ? new Date(event.created * 1000) : await firstFailure(invoice, event, stripe, prisma, account.id), paid };
}

export async function applyCommercialPayment(tx: Prisma.TransactionClient, input: PreparedCommercialPayment,
  webhookEventId: string, now = new Date()): Promise<void> {
  await tx.$queryRaw`SELECT id FROM organisations WHERE id=${input.orgId} FOR UPDATE`;
  const key = { accountId_invoiceId: { accountId: input.accountId, invoiceId: input.invoiceId } };
  const old = await tx.billingCommercialIncident.findUnique({ where: key });
  if (input.paid) {
    if (old && old.resolvedAt === null) {
      await tx.billingCommercialIncident.update({ where: { id: old.id },
        data: { resolvedAt: now, resolutionEventId: webhookEventId } });
      await tx.billingCommercialNotification.create({ data: { incidentId: old.id, stage: 'resolved', dueAt: now } });
    }
    return;
  }
  if (old) return;
  const enrollment = await tx.billingProductEnrollment.findUnique({ where: {
    serviceId_orgId: { serviceId: input.serviceId, orgId: input.orgId },
  } });
  // Unenrolled legacy services do not adopt new product policy from a notification.
  if (!enrollment?.active) return;
  const companyFailure = input.category === 'seat' || input.category === 'storage';
  const deadline = companyFailure ? weekdayGraceDeadline(input.failedAt, enrollment.billingTimezone)
    : new Date(input.failedAt.getTime() + 7 * 86_400_000);
  const incident = await tx.billingCommercialIncident.create({ data: {
    serviceId: input.serviceId, orgId: input.orgId, category: input.category,
    accountId: input.accountId, invoiceId: input.invoiceId,
    baseSubscriptionId: input.baseSubscriptionId, addonSubscriptionId: input.addonSubscriptionId,
    storageExpansionId: input.storageExpansionId, resourceId: input.resourceId, failedAt: input.failedAt,
    billingTimezone: enrollment.billingTimezone, graceEndsAt: deadline, failureEventId: webhookEventId,
  } });
  const stages = companyFailure ? [{ stage: 'initial', dueAt: input.failedAt }, { stage: 'restricted', dueAt: deadline }]
    : [{ stage: 'initial', dueAt: input.failedAt },
      { stage: 'reminder', dueAt: new Date(input.failedAt.getTime() + 3 * 86_400_000) },
      { stage: 'final_warning', dueAt: new Date(input.failedAt.getTime() + 6 * 86_400_000) },
      { stage: 'release_due', dueAt: deadline }];
  await tx.billingCommercialNotification.createMany({ data: stages.map((stage) => ({ incidentId: incident.id, ...stage })) });
}
