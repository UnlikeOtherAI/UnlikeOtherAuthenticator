import { BillingCreditAutoTopUpState } from '@prisma/client';

import type {
  BillingCreditsManagerV1,
  BillingCreditsMemberV1,
} from '../contracts/billing-statement-v1.js';
import {
  billingCreditAmount,
  billingCreditsPaymentMoney,
} from './billing-credit-display.service.js';
import type { BillingCreditProjectionData } from './billing-credit-projection-data.service.js';
import type { BillingCreditActionReadiness } from './billing-credit-action-readiness.service.js';

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
  readiness: BillingCreditActionReadiness,
): boolean {
  const catalog = data.catalogs.find(
    (row) => row.key === offer.catalogKey && row.version === offer.catalogVersion,
  );
  return Boolean(
    catalog &&
    readiness.executableCatalogIds.has(catalog.id) &&
    catalog.stripeProductId &&
    catalog.stripePriceId &&
    catalog.paymentAmountMinor === offer.paymentAmountMinor &&
    catalog.creditsReceivedMicrocredits === offer.creditsReceivedMicrocredits,
  );
}

function paymentMethod(
  data: BillingCreditProjectionData,
  readiness: BillingCreditActionReadiness,
) {
  const account = data.creditAccount;
  const status = !account.stripePaymentMethodId
    ? ('missing' as const)
    : readiness.paymentMethodExpired
      ? ('expired' as const)
    : account.autoTopUpState === BillingCreditAutoTopUpState.REQUIRES_ACTION ||
        account.autoTopUpState === BillingCreditAutoTopUpState.NEEDS_REVIEW
      ? ('requires_action' as const)
      : ('ready' as const);
  const summary = readiness.paymentMethodSummary ?? account.paymentMethodSummary;
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
  readiness: BillingCreditActionReadiness,
) {
  const policy = data.policy;
  return {
    top_up_enabled: Boolean(policy?.topUpEnabled && collectionEnabled),
    automatic_top_up_enabled: Boolean(policy?.automaticTopUpEnabled && collectionEnabled),
    title: 'Add team credits',
    description:
      'Credits fund metered usage across connected services. Subscriptions and add-ons remain separate.',
    offers: (policy?.topUpOffers ?? []).map((offer) => {
      const catalogExecutable = configuredCatalog(data, offer, readiness);
      const canResume = readiness.resumableTopUpOfferId === offer.id && catalogExecutable;
      const pendingCheckoutBlocksOffer =
        (data.unresolvedTopUpCheckouts ?? []).length > 0 &&
        !canResume &&
        !readiness.topUpCheckoutReady;
      const available = Boolean(
        policy?.topUpEnabled &&
        collectionEnabled &&
        (readiness.topUpCheckoutReady || canResume) &&
        catalogExecutable,
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
          : pendingCheckoutBlocksOffer
          ? 'A payment is already in progress. Resolve it before starting another.'
            : policy?.topUpEnabled
              ? 'This offer is unavailable right now.'
              : 'This team cannot add credits right now.',
        action: manager
          ? {
              id: 'top_up' as const,
              kind: 'hosted_redirect' as const,
              label: canResume
                ? 'Continue payment'
                : `Buy ${billingCreditAmount(offer.creditsReceivedMicrocredits).display}`,
              description: canResume
                ? 'Continue your payment for this offer.'
                : 'Start a secure payment for this offer.',
              enabled: available,
              disabled_reason: available
                ? null
                : !collectionEnabled
                  ? 'Card payments are unavailable right now.'
                  : pendingCheckoutBlocksOffer
                    ? 'A payment is already in progress. Resolve it before starting another.'
                    : 'This offer is unavailable right now.',
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
  readiness: BillingCreditActionReadiness,
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
      configuredCatalog(data, option.refillOffer, readiness),
    );
    const setupEnabled = Boolean(
      collectionEnabled &&
      policy?.automaticTopUpEnabled &&
      configured &&
      readiness.setupCheckoutReady &&
      account.autoTopUpState === BillingCreditAutoTopUpState.DISABLED &&
      !account.stripePaymentMethodId,
    );
    const updateEnabled = Boolean(
      collectionEnabled &&
      policy?.automaticTopUpEnabled &&
      configured &&
      canChange &&
      hasVerifiedMethod &&
      readiness.paymentMethodReady,
    );
    return {
      selected: account.autoTopUpOptionId === option.id,
      label: `${billingCreditAmount(option.refillOffer.creditsReceivedMicrocredits).display} below ${billingCreditAmount(option.thresholdMicrocredits).display}`,
      description: 'This option sets a monthly limit for automatic top-ups.',
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
            description: 'Review and confirm this exact option on the secure payment page.',
            enabled: setupEnabled,
            disabled_reason: setupEnabled
              ? null
              : 'Choose an available option and save a card first.',
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
            description: 'Use this threshold, refill amount, and monthly limit.',
            enabled: updateEnabled,
            disabled_reason: updateEnabled
              ? null
              : 'Choose an available option and save a card first.',
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
  readiness: BillingCreditActionReadiness,
  capResetsAt: Date | undefined,
) {
  const account = data.creditAccount;
  const policy = data.policy;
  const charged = data.autoTopUpChargedMinor;
  const cap = account.autoTopUpMonthlyChargeCapMinor;
  const remainingCap = cap === null ? null : cap > charged ? cap - charged : 0n;
  const selectedRefill = policy?.autoTopUpOptions.find(
    (option) => option.id === account.autoTopUpOptionId,
  )?.refillOffer.paymentAmountMinor;
  const pausedForCap = Boolean(
    account.autoTopUpState === BillingCreditAutoTopUpState.ACTIVE &&
      remainingCap !== null &&
      selectedRefill !== undefined &&
      remainingCap < selectedRefill,
  );
  const state = pausedForCap
    ? 'paused'
    : (account.autoTopUpState.toLowerCase() as Lowercase<BillingCreditAutoTopUpState>);
  const resetDate = capResetsAt?.toISOString().slice(0, 10);
  const recoverableState =
    account.autoTopUpState === BillingCreditAutoTopUpState.REQUIRES_ACTION ||
    account.autoTopUpState === BillingCreditAutoTopUpState.NEEDS_REVIEW ||
    account.autoTopUpState === BillingCreditAutoTopUpState.PAUSED ||
    (account.autoTopUpState === BillingCreditAutoTopUpState.ACTIVE &&
      Boolean(account.stripePaymentMethodId));
  const recoverEnabled = Boolean(collectionEnabled && recoverableState && readiness.recoverReady);
  const consentStatus = !account.autoTopUpConsentVersion
    ? ('missing' as const)
    : account.autoTopUpConsentVersion === policy?.automaticConsentVersion
      ? ('current' as const)
      : ('outdated' as const);
  return {
    state,
    display_status: `Automatic top-up is ${state.replaceAll('_', ' ')}`,
    description: pausedForCap
      ? `The monthly limit cannot cover another refill.${resetDate ? ` It resets on ${resetDate}.` : ''}`
      : state === 'disabled'
        ? 'Automatic top-up is not enabled for this team.'
        : 'The saved threshold, refill offer, and monthly limit apply.',
    threshold:
      account.autoTopUpThresholdMicrocredits === null
        ? null
        : billingCreditAmount(account.autoTopUpThresholdMicrocredits),
    refill_offer_id: account.autoTopUpRefillOfferId,
    monthly_cap: cap === null ? null : billingCreditsPaymentMoney(cap),
    charged_this_month: billingCreditsPaymentMoney(charged),
    remaining_monthly_cap:
      remainingCap === null ? null : billingCreditsPaymentMoney(remainingCap),
    payment_method: manager
      ? paymentMethod(data, readiness)
      : { status: paymentMethod(data, readiness).status },
    consent: manager
      ? {
          status: consentStatus,
          version: account.autoTopUpConsentVersion,
          consented_at: account.autoTopUpConsentedAt?.toISOString() ?? null,
          consented_by: account.autoTopUpConsentedBy
            ? { display_name: account.autoTopUpConsentedBy.name ?? 'Team member' }
            : null,
          description: 'Your agreement covers the saved threshold, refill amount, and monthly limit.',
        }
      : {
          status: consentStatus,
          version: account.autoTopUpConsentVersion,
          consented_at: account.autoTopUpConsentedAt?.toISOString() ?? null,
        },
    options: optionActions(data, requestBody, manager, collectionEnabled, readiness),
    disable_action:
      manager && account.autoTopUpState !== BillingCreditAutoTopUpState.DISABLED
        ? {
            id: 'auto_top_up_disable' as const,
            kind: 'mutation' as const,
            label: 'Turn off automatic top-up',
            description: 'Stop future automatic charges without changing available credits.',
            enabled: Boolean(collectionEnabled && readiness.disableReady),
            disabled_reason:
              collectionEnabled && readiness.disableReady
                ? null
                : 'Automatic top-up is unavailable right now.',
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
          label:
            account.autoTopUpState === BillingCreditAutoTopUpState.ACTIVE
              ? 'Change card'
              : 'Review payment',
          description: 'Open the secure payment page to review or change your card.',
          enabled: recoverEnabled,
          disabled_reason: recoverEnabled
            ? null
            : 'This action is not available right now.',
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
  readiness: BillingCreditActionReadiness,
  capResetsAt?: Date,
): Pick<BillingCreditsManagerV1, 'funding_policy' | 'automatic_top_up'> {
  return {
    funding_policy: fundingPolicy(data, body, true, collectionEnabled, readiness),
    automatic_top_up: automaticTopUp(
      data,
      body,
      true,
      collectionEnabled,
      readiness,
      capResetsAt,
    ),
  } as Pick<BillingCreditsManagerV1, 'funding_policy' | 'automatic_top_up'>;
}

export function buildMemberCreditActionsProjection(
  data: BillingCreditProjectionData,
  readiness: BillingCreditActionReadiness,
): Pick<BillingCreditsMemberV1, 'funding_policy' | 'automatic_top_up'> {
  return {
    funding_policy: null,
    automatic_top_up: {
      payment_method: {
        status: paymentMethod(data, readiness).status,
      },
    },
  };
}
