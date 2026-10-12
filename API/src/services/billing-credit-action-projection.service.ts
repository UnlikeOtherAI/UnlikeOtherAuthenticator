import type {
  BillingCreditsManagerV1,
  BillingCreditsMemberV1,
} from '../contracts/billing-statement-v1.js';
import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { formatBillingCopy } from './billing-copy-locale.js';
import {
  billingCreditCopy,
  billingBuiltInCreditOfferCopy,
  billingLocalizedCreditDisplay,
} from './billing-credit-copy.catalog.js';
import { billingCreditFundingCopy } from './billing-credit-funding-copy.catalog.js';
import { billingCreditsPaymentMoney } from './billing-credit-display.service.js';
import {
  creditAmount,
  creditCatalogExecutable,
  creditLiveRate,
  type BillingCreditActionSubject,
} from './billing-credit-action-terms.service.js';
import {
  creditPurchasePolicy,
  type BillingCreditProjectionData,
} from './billing-credit-projection-data.service.js';
import type { BillingCreditActionReadiness } from './billing-credit-action-readiness.service.js';
import {
  creditsForPayment,
  type CreditPurchaseRate,
} from './billing-credit-purchase-rate.service.js';
import {
  creditAutomaticTopUpView,
  creditPaymentMethodView,
} from './billing-credit-reload-projection.service.js';

export type { BillingCreditActionSubject } from './billing-credit-action-terms.service.js';

function fundingPolicy(
  data: BillingCreditProjectionData,
  requestBody: BillingCreditActionSubject,
  manager: boolean,
  collectionEnabled: boolean,
  readiness: BillingCreditActionReadiness,
  locale?: BillingCustomerLocale,
  purchaseRate?: CreditPurchaseRate | null,
) {
  const copy = billingCreditFundingCopy(locale);
  const policy = creditPurchasePolicy(data);
  // A USD offer fixes its credits. A GBP or EUR offer shows what today's rate
  // buys and is left out while no rate can be read.
  const live = data.purchaseCurrency !== 'USD';
  const rate = live && purchaseRate?.currency === data.purchaseCurrency ? purchaseRate : null;
  const priced = (policy?.topUpOffers ?? []).flatMap((offer) => {
    if (!live) return [{ offer, credits: offer.creditsReceivedMicrocredits }];
    const credits = rate ? creditsForPayment(offer.paymentAmountMinor, rate.baseRate) : 0n;
    return credits > 0n ? [{ offer, credits }] : [];
  });
  const offers = priced.map(({ offer, credits }) => {
    const catalogExecutable = creditCatalogExecutable(data, offer, readiness);
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
    const creditDisplay = billingLocalizedCreditDisplay(creditAmount(credits, locale).credits, locale);
    return {
      id: offer.id,
      key: offer.key,
      name: builtInCopy?.name ?? offer.name,
      description: builtInCopy?.description ?? offer.description,
      payment_amount: billingCreditsPaymentMoney(offer.paymentAmountMinor, locale, data.purchaseCurrency),
      credits_received: creditAmount(credits, locale),
      ...(rate ? { credit_rate: creditLiveRate(rate, locale) } : {}),
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
              : formatBillingCopy(live ? copy.buyOfferAtRate : copy.buyOffer, { credits: creditDisplay }),
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
  });
  const description = live && !rate && (policy?.topUpOffers.length ?? 0) > 0
    ? `${copy.description} ${formatBillingCopy(copy.rateUnavailable, { currency: data.purchaseCurrency })}`
    : offers.some((offer) => offer.available)
      ? `${copy.description} ${billingCreditCopy(locale).smallestOfferHint}`
      : copy.description;
  return {
    top_up_enabled: Boolean(policy?.topUpEnabled && collectionEnabled),
    automatic_top_up_enabled: Boolean(data.policy?.automaticTopUpEnabled && collectionEnabled),
    title: copy.title,
    description,
    offers,
  };
}

export function buildManagerCreditActionsProjection(
  data: BillingCreditProjectionData,
  body: BillingCreditActionSubject,
  collectionEnabled: boolean,
  readiness: BillingCreditActionReadiness,
  capResetsAt?: Date,
  locale?: BillingCustomerLocale,
  purchaseRate?: CreditPurchaseRate | null,
): Pick<BillingCreditsManagerV1, 'funding_policy' | 'automatic_top_up'> {
  return {
    funding_policy: fundingPolicy(data, body, true, collectionEnabled, readiness, locale, purchaseRate),
    automatic_top_up: creditAutomaticTopUpView(
      data,
      body,
      true,
      collectionEnabled,
      readiness,
      capResetsAt,
      locale,
      purchaseRate,
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
        status: creditPaymentMethodView(data, readiness, locale).status,
      },
    },
  };
}
