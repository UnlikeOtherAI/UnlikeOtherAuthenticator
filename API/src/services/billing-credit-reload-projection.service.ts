import { BillingCreditAutoTopUpState } from '@prisma/client';

import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { billingLocale, formatBillingCopy } from './billing-copy-locale.js';
import { billingCreditAutoTopUpCopy } from './billing-credit-auto-top-up-copy.catalog.js';
import {
  creditAmount,
  creditCatalogExecutable,
  creditLiveRate,
  type BillingCreditActionSubject,
} from './billing-credit-action-terms.service.js';
import type { BillingCreditActionReadiness } from './billing-credit-action-readiness.service.js';
import { billingCreditsPaymentMoney } from './billing-credit-display.service.js';
import {
  creditReloadPolicy,
  type BillingCreditProjectionData,
} from './billing-credit-projection-data.service.js';
import { creditsForPayment, type CreditPurchaseRate } from './billing-credit-purchase-rate.service.js';
import type { CreditPurchaseCurrency } from './billing-stripe-catalog-provisioning-spec.js';

type ReloadOption = {
  thresholdMicrocredits: bigint;
  thresholdAmountMinor: bigint | null;
  refillOffer: { paymentAmountMinor: bigint; creditsReceivedMicrocredits: bigint };
};

/**
 * A reload option's credits. A USD option fixes them; a GBP or EUR option buys
 * what today's rate gives, with its threshold valued in its own currency, and
 * has no terms to show while no rate can be read.
 */
function reloadTerms(option: ReloadOption, currency: CreditPurchaseCurrency, rate: CreditPurchaseRate | null) {
  if (currency === 'USD' || option.thresholdAmountMinor === null) {
    return { refillMicrocredits: option.refillOffer.creditsReceivedMicrocredits,
      thresholdMicrocredits: option.thresholdMicrocredits, thresholdValue: null };
  }
  if (!rate) return null;
  return {
    refillMicrocredits: creditsForPayment(option.refillOffer.paymentAmountMinor, rate.baseRate),
    thresholdMicrocredits: creditsForPayment(option.thresholdAmountMinor, rate.baseRate),
    thresholdValue: billingCreditsPaymentMoney(option.thresholdAmountMinor, undefined, currency),
  };
}

export function creditPaymentMethodView(
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

function optionActions(
  data: BillingCreditProjectionData,
  requestBody: BillingCreditActionSubject,
  manager: boolean,
  collectionEnabled: boolean,
  readiness: BillingCreditActionReadiness,
  locale?: BillingCustomerLocale,
  purchaseRate?: CreditPurchaseRate | null,
) {
  const copy = billingCreditAutoTopUpCopy(locale);
  const account = data.creditAccount;
  const policy = creditReloadPolicy(data);
  const currency = data.reloadCurrency;
  const rate = currency !== 'USD' && purchaseRate?.currency === currency ? purchaseRate : null;
  const canChange =
    account.autoTopUpState === BillingCreditAutoTopUpState.ACTIVE ||
    account.autoTopUpState === BillingCreditAutoTopUpState.PAUSED;
  const hasVerifiedMethod = Boolean(
    account.stripePaymentMethodId && account.autoTopUpConsentRevisionId,
  );
  // A GBP or EUR option shows what today's rate buys and is left out while no rate can be read.
  const priced = (policy?.autoTopUpOptions ?? []).flatMap((option) => {
    const terms = reloadTerms(option, currency, rate);
    return terms ? [{ option, terms }] : [];
  });
  return priced.map(({ option, terms }) => {
    const configured = Boolean(
      option.refillOffer.active &&
      option.refillOffer.automaticTopUpEligible &&
      option.monthlyChargeCapMinor >= option.refillOffer.paymentAmountMinor &&
      creditCatalogExecutable(data, option.refillOffer, readiness),
    );
    const refillMoney = billingCreditsPaymentMoney(option.refillOffer.paymentAmountMinor, locale, currency);
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
      // A USD option speaks in credits; a GBP or EUR one in what is paid and the threshold value.
      label: formatBillingCopy(copy.optionLabel, terms.thresholdValue ? {
        refill: refillMoney.display, threshold: terms.thresholdValue.display,
      } : {
        refill: creditAmount(terms.refillMicrocredits, locale).display,
        threshold: creditAmount(terms.thresholdMicrocredits, locale).display,
      }),
      description: copy.optionDescription,
      threshold: creditAmount(terms.thresholdMicrocredits, locale),
      ...(terms.thresholdValue ? { threshold_value: terms.thresholdValue } : {}),
      refill_offer_id: option.refillOfferId,
      refill_payment_amount: refillMoney,
      refill_credits_received: creditAmount(terms.refillMicrocredits, locale),
      ...(rate ? { credit_rate: creditLiveRate(rate, locale) } : {}),
      monthly_cap: billingCreditsPaymentMoney(option.monthlyChargeCapMinor, locale, currency),
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

export function creditAutomaticTopUpView(
  data: BillingCreditProjectionData,
  requestBody: BillingCreditActionSubject,
  manager: boolean,
  collectionEnabled: boolean,
  readiness: BillingCreditActionReadiness,
  capResetsAt: Date | undefined,
  locale?: BillingCustomerLocale,
  purchaseRate?: CreditPurchaseRate | null,
) {
  const copy = billingCreditAutoTopUpCopy(locale);
  const account = data.creditAccount;
  // The consented option belongs to the USD policy or the region currency's.
  const regionOption = data.regionPolicy?.autoTopUpOptions.find((option) => option.id === account.autoTopUpOptionId);
  const policy = regionOption ? data.regionPolicy : data.policy;
  const currency = (regionOption ? data.regionPolicy?.currency ?? 'USD' : 'USD') as CreditPurchaseCurrency;
  const selected = policy?.autoTopUpOptions.find((option) => option.id === account.autoTopUpOptionId);
  const selectedTerms = selected
    ? reloadTerms(selected, currency, purchaseRate?.currency === currency ? purchaseRate : null)
    : null;
  const charged = data.autoTopUpChargedMinor;
  const cap = account.autoTopUpMonthlyChargeCapMinor;
  const remainingCap = cap === null ? null : cap > charged ? cap - charged : 0n;
  const selectedRefill = selected?.refillOffer.paymentAmountMinor;
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
    threshold: currency === 'USD'
      ? account.autoTopUpThresholdMicrocredits === null ? null
        : creditAmount(account.autoTopUpThresholdMicrocredits, locale)
      : selectedTerms ? creditAmount(selectedTerms.thresholdMicrocredits, locale) : null,
    ...(selectedTerms?.thresholdValue ? { threshold_value: selectedTerms.thresholdValue } : {}),
    refill_offer_id: account.autoTopUpRefillOfferId,
    monthly_cap: cap === null ? null : billingCreditsPaymentMoney(cap, locale, currency),
    charged_this_month: billingCreditsPaymentMoney(charged, locale, currency),
    remaining_monthly_cap:
      remainingCap === null ? null : billingCreditsPaymentMoney(remainingCap, locale, currency),
    payment_method: manager
      ? creditPaymentMethodView(data, readiness, locale)
      : { status: creditPaymentMethodView(data, readiness, locale).status },
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
    options: optionActions(data, requestBody, manager, collectionEnabled, readiness, locale, purchaseRate),
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
