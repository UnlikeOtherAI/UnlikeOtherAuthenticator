import { BillingCreditAutoTopUpState } from '@prisma/client';

import type {
  BillingCreditAmount,
  BillingCreditsManagerV1,
  BillingCreditsMemberV1,
} from '../contracts/billing-statement-v1.js';
import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { billingLocale, formatBillingCopy } from './billing-copy-locale.js';
import {
  billingBuiltInCreditOfferCopy,
  billingLocalizedCreditDisplay,
} from './billing-credit-copy.catalog.js';
import { billingCreditAutoTopUpCopy } from './billing-credit-auto-top-up-copy.catalog.js';
import { billingCreditFundingCopy } from './billing-credit-funding-copy.catalog.js';
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

function creditAmount(microcredits: bigint, locale?: BillingCustomerLocale): BillingCreditAmount {
  const amount = billingCreditAmount(microcredits);
  return {
    ...amount,
    display: billingLocalizedCreditDisplay(amount.credits, locale),
  };
}

function paymentMethod(
  data: BillingCreditProjectionData,
  readiness: BillingCreditActionReadiness,
  locale?: BillingCustomerLocale,
) {
  const copy = billingCreditAutoTopUpCopy(locale);
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
      display:
        status === 'missing' ? copy.noSavedPaymentMethod : copy.savedPaymentMethod,
    };
  }
  const record = summary as Record<string, unknown>;
  const brand = typeof record.brand === 'string' ? record.brand : copy.cardFallback;
  const last4 =
    typeof record.last4 === 'string' && /^\d{4}$/.test(record.last4)
      ? formatBillingCopy(copy.cardEnding, { last4: record.last4 })
      : '';
  return { status, display: `${brand}${last4}` };
}

function fundingPolicy(
  data: BillingCreditProjectionData,
  requestBody: BillingCreditActionSubject,
  manager: boolean,
  collectionEnabled: boolean,
  readiness: BillingCreditActionReadiness,
  locale?: BillingCustomerLocale,
) {
  const copy = billingCreditFundingCopy(locale);
  const policy = data.policy;
  return {
    top_up_enabled: Boolean(policy?.topUpEnabled && collectionEnabled),
    automatic_top_up_enabled: Boolean(policy?.automaticTopUpEnabled && collectionEnabled),
    title: copy.title,
    description: copy.description,
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
      const builtInCopy = billingBuiltInCreditOfferCopy(offer.key, locale);
      const creditDisplay = billingLocalizedCreditDisplay(
        creditAmount(offer.creditsReceivedMicrocredits, locale).credits,
        locale,
      );
      return {
        id: offer.id,
        key: offer.key,
        name: builtInCopy?.name ?? offer.name,
        description: builtInCopy?.description ?? offer.description,
        payment_amount: billingCreditsPaymentMoney(offer.paymentAmountMinor),
        credits_received: creditAmount(offer.creditsReceivedMicrocredits, locale),
        available,
        unavailable_reason: available
          ? null
          : pendingCheckoutBlocksOffer
          ? copy.paymentPending
            : policy?.topUpEnabled
              ? copy.offerUnavailable
              : copy.topUpsDisabled,
        action: manager
          ? {
              id: 'top_up' as const,
              kind: 'hosted_redirect' as const,
              label: canResume
                ? copy.continuePayment
                : formatBillingCopy(copy.buyOffer, { credits: creditDisplay }),
              description: canResume
                ? copy.continuePaymentDescription
                : copy.buyOfferDescription,
              enabled: available,
              disabled_reason: available
                ? null
                : !collectionEnabled
                  ? copy.collectionUnavailable
                  : pendingCheckoutBlocksOffer
                    ? copy.paymentPending
                    : copy.unavailableForPayment,
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
  locale?: BillingCustomerLocale,
) {
  const copy = billingCreditAutoTopUpCopy(locale);
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
      label: formatBillingCopy(copy.optionLabel, {
        refill: billingLocalizedCreditDisplay(
          billingCreditAmount(option.refillOffer.creditsReceivedMicrocredits).credits,
          locale,
        ),
        threshold: billingLocalizedCreditDisplay(
          billingCreditAmount(option.thresholdMicrocredits).credits,
          locale,
        ),
      }),
      description: copy.optionDescription,
      threshold: creditAmount(option.thresholdMicrocredits, locale),
      refill_offer_id: option.refillOfferId,
      refill_payment_amount: billingCreditsPaymentMoney(option.refillOffer.paymentAmountMinor),
      refill_credits_received: creditAmount(
        option.refillOffer.creditsReceivedMicrocredits,
        locale,
      ),
      monthly_cap: billingCreditsPaymentMoney(option.monthlyChargeCapMinor),
      setup_action: manager
        ? {
            id: 'auto_top_up_setup' as const,
            kind: 'hosted_redirect' as const,
            label: copy.setupAction,
            description: copy.setupDescription,
            enabled: setupEnabled,
            disabled_reason: setupEnabled
              ? null
              : copy.setupUnavailable,
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
            label: copy.updateAction,
            description: copy.updateDescription,
            enabled: updateEnabled,
            disabled_reason: updateEnabled
              ? null
              : copy.updateUnavailable,
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
  locale?: BillingCustomerLocale,
) {
  const copy = billingCreditAutoTopUpCopy(locale);
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
  const resetDate = capResetsAt
    ? new Intl.DateTimeFormat(billingLocale(locale), {
        dateStyle: 'long',
        timeZone: 'UTC',
      }).format(capResetsAt)
    : undefined;
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
    display_status: copy.status[state],
    description: pausedForCap
      ? resetDate
        ? formatBillingCopy(copy.pausedForCapDescription, { date: resetDate })
        : copy.pausedForCapNoResetDescription
      : state === 'disabled'
        ? copy.disabledDescription
        : copy.activeDescription,
    threshold:
      account.autoTopUpThresholdMicrocredits === null
        ? null
        : creditAmount(account.autoTopUpThresholdMicrocredits, locale),
    refill_offer_id: account.autoTopUpRefillOfferId,
    monthly_cap: cap === null ? null : billingCreditsPaymentMoney(cap),
    charged_this_month: billingCreditsPaymentMoney(charged),
    remaining_monthly_cap:
      remainingCap === null ? null : billingCreditsPaymentMoney(remainingCap),
    payment_method: manager
      ? paymentMethod(data, readiness, locale)
      : { status: paymentMethod(data, readiness, locale).status },
    consent: manager
      ? {
          status: consentStatus,
          version: account.autoTopUpConsentVersion,
          consented_at: account.autoTopUpConsentedAt?.toISOString() ?? null,
          consented_by: account.autoTopUpConsentedBy
            ? {
                display_name:
                  account.autoTopUpConsentedBy.name ?? copy.consentedByFallback,
              }
            : null,
          description: copy.consentDescription,
        }
      : {
          status: consentStatus,
          version: account.autoTopUpConsentVersion,
          consented_at: account.autoTopUpConsentedAt?.toISOString() ?? null,
        },
    options: optionActions(data, requestBody, manager, collectionEnabled, readiness, locale),
    disable_action:
      manager && account.autoTopUpState !== BillingCreditAutoTopUpState.DISABLED
        ? {
            id: 'auto_top_up_disable' as const,
            kind: 'mutation' as const,
            label: copy.disableAction,
            description: copy.disableDescription,
            enabled: Boolean(collectionEnabled && readiness.disableReady),
            disabled_reason:
              collectionEnabled && readiness.disableReady
                ? null
                : copy.disableUnavailable,
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
              ? copy.changeCardAction
              : copy.reviewPaymentAction,
          description: copy.recoveryDescription,
          enabled: recoverEnabled,
          disabled_reason: recoverEnabled
            ? null
            : copy.recoveryUnavailable,
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
  locale?: BillingCustomerLocale,
): Pick<BillingCreditsManagerV1, 'funding_policy' | 'automatic_top_up'> {
  return {
    funding_policy: fundingPolicy(data, body, true, collectionEnabled, readiness, locale),
    automatic_top_up: automaticTopUp(
      data,
      body,
      true,
      collectionEnabled,
      readiness,
      capResetsAt,
      locale,
    ),
  } as Pick<BillingCreditsManagerV1, 'funding_policy' | 'automatic_top_up'>;
}

export function buildMemberCreditActionsProjection(
  data: BillingCreditProjectionData,
  readiness: BillingCreditActionReadiness,
  locale?: BillingCustomerLocale,
): Pick<BillingCreditsMemberV1, 'funding_policy' | 'automatic_top_up'> {
  return {
    funding_policy: null,
    automatic_top_up: {
      payment_method: {
        status: paymentMethod(data, readiness, locale).status,
      },
    },
  };
}
