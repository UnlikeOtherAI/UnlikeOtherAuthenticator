import type {
  BillingStatementAction,
  BillingStatementV1,
} from '../contracts/billing-statement-v1.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { billingSubscriptionCopy } from './billing-subscription-copy.catalog.js';
import { pinnedBillingReturnUrls } from './billing-return-url-policy.service.js';
import {
  getStripeSubscriptionSummary,
  type BillingSubscriptionRequest,
} from './billing-stripe-subscription.service.js';

type SubscriptionSummary = Awaited<ReturnType<typeof getStripeSubscriptionSummary>>;

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
  locale?: BillingCustomerLocale,
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
  const returns = pinnedBillingReturnUrls(credential.checkoutReturnOrigins);
  const body = actionBody(request);
  const copy = billingSubscriptionCopy(locale);
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
        label: copy.upgradeAction,
        description: copy.upgradeDescription,
        enabled: canUpgrade,
        disabled_reason: canUpgrade
          ? null
          : subscription
            ? copy.activeSubscription
            : !canManage
              ? copy.onlyManagerUpgrade
              : copy.upgradeUnavailable,
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
        label: copy.managePaymentAction,
        description: copy.portalDescription,
        enabled: canOpenPortal,
        disabled_reason: canOpenPortal
          ? null
          : !canManage
            ? copy.onlyManagerPayment
            : copy.portalUnavailable,
        request: {
          method: 'POST',
          path: '/billing/v1/stripe/portal-session',
          body: { ...body, return_url: returns.portal },
        },
      },
      {
        id: 'cancel',
        kind: 'confirmation_dialog',
        label: copy.cancelSubscriptionAction,
        description: copy.cancelDescription,
        enabled: canCancel,
        disabled_reason: canCancel
          ? null
          : subscription?.cancel_at_period_end
            ? copy.cancellationAlreadyScheduled
            : !canManage
              ? copy.onlyManagerCancel
              : copy.noCancellableSubscription,
        request: {
          method: 'POST',
          path: '/billing/v1/cancellation/preview',
          body,
        },
      },
    ],
  };
}
