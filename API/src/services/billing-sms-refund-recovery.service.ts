import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { z } from 'zod';

import { getAdminAuthDomain } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { lockBillingAdminEffectAuthority } from './billing-admin-effect-authority.service.js';
import type { SmsPolicyActor } from './billing-sms-policy-admin.service.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';
import { assertRecurringAddonSubscriptionBinding, recurringAddonSubscriptionInclude } from './billing-recurring-addon-subscription.service.js';
import { assertRecurringAddonMetadata } from './billing-recurring-addon-stripe-binding.service.js';
import { assertStripeObjectLivemode, requireStripeBillingEnabled } from './billing-stripe-client.service.js';
import { stripeInvoiceMinor, verifyStripeInvoiceCash } from './billing-stripe-payment-evidence.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

export const SmsRefundRecoverySchema = z.object({
  subscription_id: z.string().min(1).max(160),
  refund_ids: z.array(z.string().regex(/^re_[a-zA-Z0-9]+$/)).min(1).max(20)
    .refine((ids) => new Set(ids).size === ids.length, 'Refund IDs must be distinct.'),
  reason: z.string().trim().min(8).max(500),
  verify_existing_refunds: z.literal(true),
}).strict();
type StripeRefundReader = Pick<Stripe, 'accounts' | 'subscriptions' | 'invoices' | 'invoicePayments' |
  'paymentIntents' | 'charges' | 'refunds' | 'balanceTransactions'>;
type Input = z.infer<typeof SmsRefundRecoverySchema>;
function unproven(code = 'BILLING_SMS_REFUND_EVIDENCE_UNPROVEN') {
  return new AppError('BAD_REQUEST', 409, code);
}

/** Read existing Stripe cash/refund evidence only. No refund, payment or provider creation. */
export async function verifySmsNumberRefund(id: string, input: Input, actor: SmsPolicyActor,
  deps?: { prisma?: PrismaClient; stripe?: StripeRefundReader; livemode?: boolean }) {
  const value = SmsRefundRecoverySchema.parse(input); const db = deps?.prisma ?? getAdminPrisma();
  const gate = deps?.stripe ? { client: deps.stripe, livemode: deps.livemode ?? false } : requireStripeBillingEnabled();
  const stripe = gate.client;
  const resource = await db.billingSmsNumberResource.findUnique({ where: { id } });
  if (!resource?.offerId || !['refund_required', 'ended'].includes(resource.state)) throw unproven('BILLING_SMS_REFUND_RESOURCE_UNAVAILABLE');
  const local = await db.billingRecurringAddonSubscription.findUnique({ where: { id: value.subscription_id },
    include: { ...recurringAddonSubscriptionInclude, account: true } });
  if (!local || local.serviceId !== resource.serviceId || local.orgId !== resource.orgId ||
    local.offerId !== resource.offerId || local.scope !== 'ORGANISATION' || local.teamId !== null ||
    local.offer.resourceKind !== 'sms_mobile_number' || local.offer.resourceId !== resource.id ||
    !local.initialInvoiceId || !local.initialInvoicePaidAt || !local.activationWebhookEventId ||
    local.livemode !== gate.livemode || local.account.livemode !== gate.livemode ||
    local.customer.accountId !== local.accountId || local.customer.orgId !== resource.orgId ||
    local.catalog.accountId !== local.accountId || local.catalog.offerId !== resource.offerId ||
    local.catalog.monthlyAmountMinor !== local.offer.monthlyAmountMinor || local.catalog.currency !== local.offer.currency) throw unproven();
  const account = { id: local.accountId, stripeAccountId: local.account.stripeAccountId, livemode: gate.livemode };
  const currentAccount = await stripe.accounts.retrieveCurrent();
  if (currentAccount.id !== account.stripeAccountId) throw unproven('BILLING_SMS_REFUND_ACCOUNT_MISMATCH');
  const remote = await stripe.subscriptions.retrieve(local.stripeSubscriptionId);
  assertRecurringAddonSubscriptionBinding(local, remote, account);
  if (remote.status !== 'canceled') throw unproven('BILLING_SMS_REFUND_SUBSCRIPTION_NOT_CANCELED');
  const invoice = await stripe.invoices.retrieve(local.initialInvoiceId);
  const invoices = await stripe.invoices.list({ subscription: local.stripeSubscriptionId, limit: 100 });
  // A delayed acquisition failure can cross renewal. Initial-payment evidence
  // alone cannot close a resource that has another paid or collectible invoice.
  if (invoices.has_more || !invoices.data.some((row) => row.id === local.initialInvoiceId) ||
    invoices.data.some((row) => row.id !== local.initialInvoiceId &&
      ((row.status === 'paid' && row.amount_paid > 0) ||
       (['open', 'draft'].includes(row.status ?? '') && row.amount_remaining > 0)))) {
    throw unproven('BILLING_SMS_REFUND_ADDITIONAL_INVOICES_UNRESOLVED');
  }
  assertStripeObjectLivemode(invoice, gate.livemode);
  const details = invoice.parent?.type === 'subscription_details' ? invoice.parent.subscription_details : null;
  const line = invoice.lines.data[0];
  if (invoice.id !== local.initialInvoiceId || stripeExternalId(details?.subscription) !== local.stripeSubscriptionId ||
    stripeExternalId(invoice.customer) !== local.customer.stripeCustomerId || invoice.status !== 'paid' ||
    invoice.billing_reason !== 'subscription_create' || invoice.currency.toUpperCase() !== local.catalog.currency ||
    stripeInvoiceMinor(invoice.amount_paid) !== local.catalog.monthlyAmountMinor ||
    stripeInvoiceMinor(invoice.amount_due) !== local.catalog.monthlyAmountMinor || invoice.amount_remaining !== 0 ||
    invoice.lines.has_more || invoice.lines.data.length !== 1 || !line ||
    stripeInvoiceMinor(line.amount) !== local.catalog.monthlyAmountMinor ||
    line.parent?.type !== 'subscription_item_details' ||
    line.parent.subscription_item_details?.subscription !== local.stripeSubscriptionId ||
    line.parent.subscription_item_details?.subscription_item !== local.stripeItemId ||
    line.parent.subscription_item_details?.proration || line.quantity !== 1 ||
    stripeExternalId(line.pricing?.price_details?.price) !== local.catalog.stripePriceId) throw unproven();
  assertRecurringAddonMetadata(details?.metadata, local.checkout, account);
  const cash = await verifyStripeInvoiceCash(invoice, stripe);
  const totals = new Map<string, bigint>();
  const refunds: Array<{ id: string; charge: string; intent: string; amount: string; currency: string;
    balance_id: string; balance_amount: number; balance_currency: string; exchange_rate: number | null; occurred_at: number }> = [];
  for (const refundId of [...value.refund_ids].sort()) {
    const refund = await stripe.refunds.retrieve(refundId);
    // Stripe Refunds do not expose livemode; exact account, original charge and
    // PaymentIntent (already mode-verified by cash proof) establish their mode.
    const chargeId = stripeExternalId(refund.charge); const intentId = stripeExternalId(refund.payment_intent);
    const payment = cash.payments.find((row) => row.charge_id === chargeId && row.payment_intent_id === intentId);
    const balanceId = stripeExternalId(refund.balance_transaction);
    if (refund.id !== refundId || refund.status !== 'succeeded' || !payment || !chargeId || !intentId ||
      refund.currency !== invoice.currency || !balanceId || refund.failure_balance_transaction ||
      stripeInvoiceMinor(refund.amount) <= 0n) throw unproven();
    const balance = await stripe.balanceTransactions.retrieve(balanceId);
    if (balance.id !== balanceId || stripeExternalId(balance.source) !== refund.id ||
      !['refund', 'payment_refund'].includes(balance.type) || !['pending', 'available'].includes(balance.status) ||
      !Number.isSafeInteger(balance.amount) || balance.amount >= 0 ||
      !Number.isSafeInteger(balance.created) || balance.created <= 0 ||
      (balance.currency === refund.currency ? BigInt(-balance.amount) !== BigInt(refund.amount)
        : !balance.exchange_rate || !Number.isFinite(balance.exchange_rate) || balance.exchange_rate <= 0)) throw unproven();
    totals.set(payment.charge_id, (totals.get(payment.charge_id) ?? 0n) + BigInt(refund.amount));
    refunds.push({ id: refund.id, charge: chargeId, intent: intentId, amount: refund.amount.toString(),
      currency: refund.currency, balance_id: balance.id, balance_amount: balance.amount,
      balance_currency: balance.currency, exchange_rate: balance.exchange_rate, occurred_at: balance.created });
  }
  if (cash.payments.some((payment) => totals.get(payment.charge_id) !== BigInt(payment.amount_minor))) throw unproven('BILLING_SMS_REFUND_INCOMPLETE');
  const facts = { resource_id: resource.id, organisation_id: resource.orgId, service_id: resource.serviceId,
    quote_id: resource.quoteId, offer_id: resource.offerId, subscription_id: local.id,
    stripe_account_id: account.stripeAccountId, livemode: gate.livemode,
    stripe_subscription_id: remote.id, initial_invoice_id: invoice.id, payments: cash.payments, refunds };
  const digest = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  const refundedAt = new Date(Math.max(...refunds.map((refund) => refund.occurred_at)) * 1000);
  return db.$transaction(async (tx) => {
    await lockRefreshSessionUserDomain({ userId: actor.userId, domain: getAdminAuthDomain() }, { prisma: tx });
    await lockBillingAdminEffectAuthority(tx, actor);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))::text`);
    const locked = await tx.$queryRaw<Array<{ state: string; refundEvidenceDigest: string | null; refundedAt: Date | null }>>(
      Prisma.sql`SELECT state, refund_evidence_digest AS "refundEvidenceDigest", refunded_at AS "refundedAt"
        FROM billing_sms_number_resources WHERE id = ${id} FOR UPDATE`);
    const current = await tx.billingSmsNumberResource.findUnique({ where: { id } });
    const subscription = await tx.billingRecurringAddonSubscription.findUnique({ where: { id: local.id } });
    if (!current || !locked[0] || current.offerId !== resource.offerId || current.quoteId !== resource.quoteId ||
      current.serviceId !== resource.serviceId || current.orgId !== resource.orgId ||
      current.accountSid !== resource.accountSid || current.phoneNumberSid !== resource.phoneNumberSid ||
      !subscription || subscription.accountId !== local.accountId || subscription.customerId !== local.customerId ||
      subscription.offerId !== local.offerId || subscription.orgId !== local.orgId ||
      subscription.stripeSubscriptionId !== local.stripeSubscriptionId ||
      subscription.initialInvoiceId !== local.initialInvoiceId || subscription.livemode !== local.livemode) throw unproven('BILLING_SMS_REFUND_BINDING_CHANGED');
    if (locked[0].state === 'ended' && locked[0].refundEvidenceDigest === digest && locked[0].refundedAt) {
      return { resource_id: id, state: 'ended' as const, evidence_digest: digest, refunded_at: locked[0].refundedAt.toISOString() };
    }
    if (locked[0].state !== 'refund_required' || locked[0].refundEvidenceDigest || locked[0].refundedAt) throw unproven('BILLING_SMS_REFUND_STATE_CHANGED');
    await tx.$executeRaw(Prisma.sql`UPDATE billing_sms_number_resources SET state = 'ended', recovery_reason = NULL,
      refund_evidence_digest = ${digest}, refunded_at = ${refundedAt}, updated_at = ${new Date()} WHERE id = ${id}`);
    await tx.adminAuditLog.create({ data: { actorEmail: actor.email, action: 'billing.sms_refund_verified',
      metadata: { ...facts, actor_user_id: actor.userId, reason: value.reason, evidence_digest: digest },
    } });
    return { resource_id: id, state: 'ended' as const, evidence_digest: digest, refunded_at: refundedAt.toISOString() };
  });
}
