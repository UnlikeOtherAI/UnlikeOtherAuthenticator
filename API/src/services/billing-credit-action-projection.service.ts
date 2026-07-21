import { BillingCreditAutoTopUpAttemptStatus, BillingCreditAutoTopUpState } from '@prisma/client';

import type {
  BillingCreditsManagerV1,
  BillingCreditsMemberV1,
} from '../contracts/billing-statement-v1.js';
import {
  billingCreditAmount,
  billingCreditsPaymentMoney,
} from './billing-credit-display.service.js';
import type { BillingCreditProjectionData } from './billing-credit-projection-data.service.js';

export type BillingCreditActionSubject = {
  product: string;
  organisation_id: string;
  team_id: string;
  user_id: string;
};

function configuredCatalog(
  data: BillingCreditProjectionData,
  offer: {
    catalogKey: string;
    catalogVersion: number;
    paymentAmountMinor: bigint;
    creditsReceivedMicrocredits: bigint;
  },
): boolean {
  const catalog = data.catalogs.find(
    (row) => row.key === offer.catalogKey && row.version === offer.catalogVersion,
  );
  return Boolean(
    catalog?.stripeProductId &&
    catalog.stripePriceId &&
    catalog.paymentAmountMinor === offer.paymentAmountMinor &&
    catalog.creditsReceivedMicrocredits === offer.creditsReceivedMicrocredits,
  );
}

function paymentMethod(data: BillingCreditProjectionData) {
  const account = data.creditAccount;
  const status = !account.stripePaymentMethodId
    ? ('missing' as const)
    : account.autoTopUpState === BillingCreditAutoTopUpState.REQUIRES_ACTION ||
        account.autoTopUpState === BillingCreditAutoTopUpState.NEEDS_REVIEW
      ? ('requires_action' as const)
      : ('ready' as const);
  const summary = account.paymentMethodSummary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return {
      status,
      display: status === 'missing' ? 'No payment method saved' : 'Saved payment method',
    };
  }
  const record = summary as Record<string, unknown>;
  const brand = typeof record.brand === 'string' ? record.brand : 'Card';
  const last4 =
    typeof record.last4 === 'string' && /^\d{4}$/.test(record.last4)
      ? ` ending in ${record.last4}`
      : '';
  return { status, display: `${brand}${last4}` };
}

function fundingPolicy(
  data: BillingCreditProjectionData,
  requestBody: BillingCreditActionSubject,
  manager: boolean,
  collectionEnabled: boolean,
) {
  const policy = data.policy;
  return {
    top_up_enabled: Boolean(policy?.topUpEnabled && collectionEnabled),
    automatic_top_up_enabled: Boolean(policy?.automaticTopUpEnabled && collectionEnabled),
    title: 'Add team credits',
    description:
      'Credits fund metered usage across connected services. Subscriptions and add-ons remain separate.',
    offers: (policy?.topUpOffers ?? []).map((offer) => {
      const available = Boolean(
        policy?.topUpEnabled && collectionEnabled && configuredCatalog(data, offer),
      );
      return {
        id: offer.id,
        key: offer.key,
        name: offer.name,
        description: offer.description,
        payment_amount: billingCreditsPaymentMoney(offer.paymentAmountMinor),
        credits_received: billingCreditAmount(offer.creditsReceivedMicrocredits),
        available,
        unavailable_reason: available
          ? null
          : policy?.topUpEnabled
            ? 'This offer is not configured for the active Stripe account.'
            : 'Top-ups are disabled for this service.',
        action: manager
          ? {
              id: 'top_up' as const,
              kind: 'hosted_redirect' as const,
              label: `Buy ${billingCreditAmount(offer.creditsReceivedMicrocredits).display}`,
              description: 'Open secure Checkout for this exact UOA-defined offer.',
              enabled: available,
              disabled_reason: available
                ? null
                : !collectionEnabled
                  ? 'Stripe credit collection is unavailable.'
                  : 'This offer is not available for the active Stripe account.',
              request: {
                method: 'POST' as const,
                path: '/billing/v1/credits/top-up-checkout' as const,
                body: { ...requestBody, offer_id: offer.id },
              },
            }
          : null,
      };
    }),
  };
}

function optionActions(
  data: BillingCreditProjectionData,
  requestBody: BillingCreditActionSubject,
  manager: boolean,
  collectionEnabled: boolean,
) {
  const account = data.creditAccount;
  const policy = data.policy;
  const canChange =
    account.autoTopUpState === BillingCreditAutoTopUpState.ACTIVE ||
    account.autoTopUpState === BillingCreditAutoTopUpState.PAUSED;
  const hasVerifiedMethod = Boolean(
    account.stripePaymentMethodId && account.autoTopUpConsentRevisionId,
  );
  return (policy?.autoTopUpOptions ?? []).map((option) => {
    const configured = Boolean(
      option.refillOffer.active &&
      option.refillOffer.automaticTopUpEligible &&
      option.monthlyChargeCapMinor >= option.refillOffer.paymentAmountMinor &&
      configuredCatalog(data, option.refillOffer),
    );
    const setupEnabled = Boolean(
      collectionEnabled &&
      policy?.automaticTopUpEnabled &&
      configured &&
      account.autoTopUpState === BillingCreditAutoTopUpState.DISABLED &&
      !account.stripePaymentMethodId,
    );
    const updateEnabled = Boolean(
      collectionEnabled &&
      policy?.automaticTopUpEnabled &&
      configured &&
      canChange &&
      hasVerifiedMethod,
    );
    return {
      selected: account.autoTopUpOptionId === option.id,
      label: `${billingCreditAmount(option.refillOffer.creditsReceivedMicrocredits).display} below ${billingCreditAmount(option.thresholdMicrocredits).display}`,
      description: 'A bounded UOA option; products cannot submit arbitrary amounts.',
      threshold: billingCreditAmount(option.thresholdMicrocredits),
      refill_offer_id: option.refillOfferId,
      refill_payment_amount: billingCreditsPaymentMoney(option.refillOffer.paymentAmountMinor),
      refill_credits_received: billingCreditAmount(option.refillOffer.creditsReceivedMicrocredits),
      monthly_cap: billingCreditsPaymentMoney(option.monthlyChargeCapMinor),
      setup_action: manager
        ? {
            id: 'auto_top_up_setup' as const,
            kind: 'hosted_redirect' as const,
            label: 'Set up automatic top-up',
            description: 'Review and consent to this exact option in secure Checkout.',
            enabled: setupEnabled,
            disabled_reason: setupEnabled
              ? null
              : 'Setup requires an available UOA option and no existing payment method.',
            request: {
              method: 'POST' as const,
              path: '/billing/v1/credits/auto-top-up/setup' as const,
              body: { ...requestBody, option_id: option.id },
            },
          }
        : null,
      update_action: manager
        ? {
            id: 'auto_top_up_update' as const,
            kind: 'mutation' as const,
            label: 'Use this automatic top-up option',
            description: 'Select this UOA-defined threshold, refill, and cap.',
            enabled: updateEnabled,
            disabled_reason: updateEnabled
              ? null
              : 'Updating requires active consent, a verified payment method, and an available option.',
            request: {
              method: 'POST' as const,
              path: '/billing/v1/credits/auto-top-up/update' as const,
              body: { ...requestBody, option_id: option.id },
            },
          }
        : null,
    };
  });
}

function automaticTopUp(
  data: BillingCreditProjectionData,
  requestBody: BillingCreditActionSubject,
  manager: boolean,
  collectionEnabled: boolean,
) {
  const account = data.creditAccount;
  const policy = data.policy;
  const state = account.autoTopUpState.toLowerCase() as Lowercase<BillingCreditAutoTopUpState>;
  const charged = data.autoTopUpChargedMinor;
  const cap = account.autoTopUpMonthlyChargeCapMinor;
  const selectedOption = policy?.autoTopUpOptions.find(
    (option) => option.id === account.autoTopUpOptionId,
  );
  const selectedConfigured = Boolean(
    selectedOption && configuredCatalog(data, selectedOption.refillOffer),
  );
  const hasRecoverableAttempt = data.unresolvedAttempts.some(
    (attempt) =>
      (attempt.status === BillingCreditAutoTopUpAttemptStatus.REQUIRES_ACTION ||
        attempt.status === BillingCreditAutoTopUpAttemptStatus.NEEDS_REVIEW) &&
      data.catalogs.some(
        (catalog) =>
          catalog.id === attempt.catalogId && catalog.stripeProductId && catalog.stripePriceId,
      ),
  );
  const recoverableState =
    account.autoTopUpState === BillingCreditAutoTopUpState.REQUIRES_ACTION ||
    account.autoTopUpState === BillingCreditAutoTopUpState.NEEDS_REVIEW ||
    account.autoTopUpState === BillingCreditAutoTopUpState.PAUSED;
  const recoverEnabled = Boolean(
    collectionEnabled && recoverableState && (hasRecoverableAttempt || selectedConfigured),
  );
  const consentStatus = !account.autoTopUpConsentVersion
    ? ('missing' as const)
    : account.autoTopUpConsentVersion === policy?.automaticConsentVersion
      ? ('current' as const)
      : ('outdated' as const);
  return {
    state,
    display_status: `Automatic top-up is ${state.replaceAll('_', ' ')}`,
    description:
      state === 'disabled'
        ? 'Automatic top-up is not enabled for this team.'
        : 'UOA applies the saved threshold, refill offer, and monthly charge cap.',
    threshold:
      account.autoTopUpThresholdMicrocredits === null
        ? null
        : billingCreditAmount(account.autoTopUpThresholdMicrocredits),
    refill_offer_id: account.autoTopUpRefillOfferId,
    monthly_cap: cap === null ? null : billingCreditsPaymentMoney(cap),
    charged_this_month: billingCreditsPaymentMoney(charged),
    remaining_monthly_cap:
      cap === null ? null : billingCreditsPaymentMoney(cap > charged ? cap - charged : 0n),
    payment_method: manager ? paymentMethod(data) : { status: paymentMethod(data).status },
    consent: manager
      ? {
          status: consentStatus,
          version: account.autoTopUpConsentVersion,
          consented_at: account.autoTopUpConsentedAt?.toISOString() ?? null,
          consented_by: account.autoTopUpConsentedBy
            ? { display_name: account.autoTopUpConsentedBy.name ?? 'Team member' }
            : null,
          description: 'Consent covers the saved threshold, refill offer, and monthly cap.',
        }
      : {
          status: consentStatus,
          version: account.autoTopUpConsentVersion,
          consented_at: account.autoTopUpConsentedAt?.toISOString() ?? null,
        },
    options: optionActions(data, requestBody, manager, collectionEnabled),
    disable_action:
      manager && account.autoTopUpState !== BillingCreditAutoTopUpState.DISABLED
        ? {
            id: 'auto_top_up_disable' as const,
            kind: 'mutation' as const,
            label: 'Turn off automatic top-up',
            description: 'Stop future automatic charges without changing available credits.',
            enabled: Boolean(collectionEnabled && selectedConfigured),
            disabled_reason:
              collectionEnabled && selectedConfigured
                ? null
                : 'The current automatic top-up policy is unavailable.',
            request: {
              method: 'POST' as const,
              path: '/billing/v1/credits/auto-top-up/disable' as const,
              body: requestBody,
            },
          }
        : null,
    recover_action: manager
      ? {
          id: 'auto_top_up_recover' as const,
          kind: 'hosted_redirect' as const,
          label: 'Review payment',
          description: 'Open UOA recovery when a payment requires customer action or review.',
          enabled: recoverEnabled,
          disabled_reason: recoverEnabled
            ? null
            : 'No automatic top-up currently has verified recovery evidence.',
          request: {
            method: 'POST' as const,
            path: '/billing/v1/credits/auto-top-up/recover' as const,
            body: requestBody,
          },
        }
      : null,
  };
}

export function buildManagerCreditActionsProjection(
  data: BillingCreditProjectionData,
  body: BillingCreditActionSubject,
  collectionEnabled: boolean,
): Pick<BillingCreditsManagerV1, 'funding_policy' | 'automatic_top_up'> {
  return {
    funding_policy: fundingPolicy(data, body, true, collectionEnabled),
    automatic_top_up: automaticTopUp(data, body, true, collectionEnabled),
  } as Pick<BillingCreditsManagerV1, 'funding_policy' | 'automatic_top_up'>;
}

export function buildMemberCreditActionsProjection(
  data: BillingCreditProjectionData,
  body: BillingCreditActionSubject,
): Pick<BillingCreditsMemberV1, 'funding_policy' | 'automatic_top_up'> {
  return {
    funding_policy: fundingPolicy(data, body, false, false),
    automatic_top_up: automaticTopUp(data, body, false, false),
  } as Pick<BillingCreditsMemberV1, 'funding_policy' | 'automatic_top_up'>;
}
