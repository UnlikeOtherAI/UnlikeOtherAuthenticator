import { BillingRecurringAddonCheckoutStatus, type Prisma } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import type { StripeAccountContext } from './billing-stripe-client.service.js';
import { recurringAddonPeriod } from './billing-recurring-addon-stripe-binding.service.js';
import type { PreparedRecurringAddonWebhook } from './billing-recurring-addon-webhook.service.js';

function subscriptionMutable(remote: Stripe.Subscription) {
  const period = recurringAddonPeriod(remote);
  return {
    status: remote.status,
    cancelAtPeriodEnd: remote.cancel_at_period_end,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
  };
}

function deactivation(
  local: Extract<PreparedRecurringAddonWebhook, { kind: 'subscription_sync' }>['local'],
  status: string,
  eventAt: Date,
): Date | null {
  return ['canceled', 'incomplete_expired'].includes(status) &&
    local.entitlementActivatedAt &&
    !local.entitlementDeactivatedAt
    ? eventAt
    : local.entitlementDeactivatedAt;
}

export async function applyRecurringAddonWebhook(
  tx: Prisma.TransactionClient,
  prepared: PreparedRecurringAddonWebhook,
  webhookEventId: string,
  account: StripeAccountContext,
): Promise<void> {
  if (prepared.kind === 'checkout_expired') {
    await tx.billingRecurringAddonCheckout.updateMany({
      where: {
        id: prepared.checkout.id,
        accountId: account.id,
        status: { in: ['CREATING', 'OPEN', 'NEEDS_REVIEW'] },
      },
      data: {
        stripeCheckoutSessionId: prepared.session.id,
        status: BillingRecurringAddonCheckoutStatus.EXPIRED,
        expiresAt: new Date(prepared.session.expires_at * 1000),
      },
    });
    return;
  }
  if (prepared.kind === 'checkout_completed') {
    if (prepared.checkout.status === BillingRecurringAddonCheckoutStatus.COMPLETE) {
      if (
        prepared.checkout.stripeCheckoutSessionId !== prepared.session.id ||
        prepared.checkout.stripeSubscriptionId !== prepared.subscription.id
      ) {
        throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_CHECKOUT_REBIND_FORBIDDEN');
      }
      return;
    }
    await tx.billingRecurringAddonCheckout.update({
      where: { id: prepared.checkout.id },
      data: {
        stripeCheckoutSessionId: prepared.session.id,
        stripeSubscriptionId: prepared.subscription.id,
        completionWebhookEventId: webhookEventId,
        status: BillingRecurringAddonCheckoutStatus.COMPLETE,
        expiresAt: new Date(prepared.session.expires_at * 1000),
        completedAt: prepared.eventAt,
      },
    });
    const period = recurringAddonPeriod(prepared.subscription);
    await tx.billingRecurringAddonSubscription.create({
      data: {
        accountId: prepared.checkout.accountId,
        checkoutId: prepared.checkout.id,
        customerId: prepared.checkout.customerId,
        catalogId: prepared.checkout.catalogId,
        serviceId: prepared.checkout.serviceId,
        offerId: prepared.checkout.offerId,
        offerKey: prepared.checkout.offerKey,
        orgId: prepared.checkout.orgId,
        teamId: prepared.checkout.teamId,
        subscribingUserId: prepared.checkout.subscribingUserId,
        scope: prepared.checkout.scope,
        scopeKey: prepared.checkout.scopeKey,
        stripeSubscriptionId: prepared.subscription.id,
        stripeItemId: prepared.item.id,
        status: prepared.subscription.status,
        cancelAtPeriodEnd: prepared.subscription.cancel_at_period_end,
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
        livemode: account.livemode,
      },
    });
    return;
  }
  const status = prepared.remote?.status ?? 'canceled';
  const mutable = prepared.remote
    ? subscriptionMutable(prepared.remote)
    : { status, cancelAtPeriodEnd: true };
  if (prepared.kind === 'invoice_paid') {
    if (prepared.local.initialInvoicePaidAt) {
      if (prepared.local.initialInvoiceId !== prepared.invoice.id) {
        throw new AppError('INTERNAL', 503, 'STRIPE_RECURRING_ADDON_ACTIVATION_REBIND_FORBIDDEN');
      }
      return;
    }
    if (['canceled', 'incomplete_expired'].includes(prepared.local.status)) return;
    await tx.billingRecurringAddonSubscription.update({
      where: { id: prepared.local.id },
      data: {
        ...subscriptionMutable(prepared.remote),
        initialInvoicePaidAt: prepared.eventAt,
        initialInvoiceId: prepared.invoice.id,
        activationWebhookEventId: webhookEventId,
        entitlementActivatedAt: prepared.eventAt,
        entitlementDeactivatedAt: deactivation(
          prepared.local,
          prepared.remote.status,
          prepared.eventAt,
        ),
      },
    });
    return;
  }
  if (['canceled', 'incomplete_expired'].includes(prepared.local.status)) return;
  await tx.billingRecurringAddonSubscription.update({
    where: { id: prepared.local.id },
    data: {
      ...mutable,
      entitlementDeactivatedAt: deactivation(prepared.local, status, prepared.eventAt),
    },
  });
}
