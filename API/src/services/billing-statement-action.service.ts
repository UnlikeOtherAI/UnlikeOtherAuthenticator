import type {
  BillingStatementAction,
  BillingStatementV1,
} from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  getStripeSubscriptionSummary,
  type BillingSubscriptionRequest,
} from './billing-stripe-subscription.service.js';

type SubscriptionSummary = Awaited<ReturnType<typeof getStripeSubscriptionSummary>>;

function pinnedReturnUrls(origins: string[]): {
  checkoutSuccess: string;
  checkoutCancel: string;
  portal: string;
} {
  const origin = origins[0];
  if (!origin) throw new AppError('INTERNAL', 500, 'BILLING_RETURN_URL_UNSET');
  const portal = new URL('/', origin);
  const success = new URL(portal);
  success.searchParams.set('uoa_billing', 'checkout_complete');
  const cancel = new URL(portal);
  cancel.searchParams.set('uoa_billing', 'checkout_cancelled');
  return {
    checkoutSuccess: success.toString(),
    checkoutCancel: cancel.toString(),
    portal: portal.toString(),
  };
}

function actionBody(request: BillingSubscriptionRequest): Record<string, string> {
  return {
    product: request.product,
    organisation_id: request.organisationId,
    team_id: request.teamId,
    user_id: request.userId,
  };
}

export function billingStatementActions(
  summary: SubscriptionSummary,
  request: BillingSubscriptionRequest,
  credential: VerifiedBillingAppKey,
): {
  capabilities: BillingStatementV1['capabilities'];
  actions: BillingStatementAction[];
} {
  const subscription = summary.subscription;
  const canManage = summary.can_manage;
  const canUpgrade =
    canManage &&
    !subscription &&
    summary.tariff.payment_collection_enabled &&
    summary.tariff.collection_mode === 'stripe' &&
    summary.stripe_collection_enabled;
  const canOpenPortal = Boolean(canManage && subscription && summary.stripe_collection_enabled);
  const canCancel = Boolean(
    canManage &&
    subscription &&
    !subscription.cancel_at_period_end &&
    summary.stripe_collection_enabled,
  );
  const returns = pinnedReturnUrls(credential.checkoutReturnOrigins);
  const body = actionBody(request);
  return {
    capabilities: {
      can_upgrade: canUpgrade,
      can_open_portal: canOpenPortal,
      can_cancel: canCancel,
    },
    actions: [
      {
        id: 'upgrade',
        kind: 'hosted_redirect',
        label: 'Upgrade plan',
        description: 'Choose and pay for this product through Stripe Checkout.',
        enabled: canUpgrade,
        disabled_reason: canUpgrade
          ? null
          : subscription
            ? 'A subscription is already active.'
            : !canManage
              ? 'Only a billing manager can upgrade.'
              : 'Online payment is not available for this plan.',
        request: {
          method: 'POST',
          path: '/billing/v1/stripe/checkout-session',
          body: {
            ...body,
            success_url: returns.checkoutSuccess,
            cancel_url: returns.checkoutCancel,
          },
        },
      },
      {
        id: 'portal',
        kind: 'hosted_redirect',
        label: 'Manage payment',
        description: 'Open Stripe’s hosted billing portal.',
        enabled: canOpenPortal,
        disabled_reason: canOpenPortal
          ? null
          : !canManage
            ? 'Only a billing manager can manage payment.'
            : 'No manageable Stripe subscription is active.',
        request: {
          method: 'POST',
          path: '/billing/v1/stripe/portal-session',
          body: { ...body, return_url: returns.portal },
        },
      },
      {
        id: 'cancel',
        kind: 'confirmation_dialog',
        label: 'Cancel subscription',
        description: 'Preview the exact direct products affected before confirming cancellation.',
        enabled: canCancel,
        disabled_reason: canCancel
          ? null
          : subscription?.cancel_at_period_end
            ? 'Cancellation is already scheduled.'
            : !canManage
              ? 'Only a billing manager can cancel.'
              : 'No cancellable Stripe subscription is active.',
        request: {
          method: 'POST',
          path: '/billing/v1/cancellation/preview',
          body,
        },
      },
    ],
  };
}
