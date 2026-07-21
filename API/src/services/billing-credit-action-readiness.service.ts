import { BillingCreditAutoTopUpAttemptStatus, BillingCreditAutoTopUpState } from '@prisma/client';
import type Stripe from 'stripe';

import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import type { CreditCollectionContext } from './billing-credit-account.service.js';
import type { BillingCreditProjectionData } from './billing-credit-projection-data.service.js';
import { assertCreditCatalogPrice } from './billing-credit-funding-context.service.js';
import { assertCreditFundingMetadata } from './billing-credit-funding-binding.service.js';
import { exactMinor, requireUsd } from './billing-credit-funding-webhook-validation.service.js';
import { pinnedBillingReturnUrls } from './billing-return-url-policy.service.js';
import { assertStripeObjectLivemode } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

export type BillingCreditActionReadiness = {
  executableCatalogIds: ReadonlySet<string>;
  paymentMethodReady: boolean;
  topUpCheckoutReady: boolean;
  setupCheckoutReady: boolean;
  disableReady: boolean;
  recoverReady: boolean;
};

export function unavailableBillingCreditActions(): BillingCreditActionReadiness {
  return {
    executableCatalogIds: new Set(),
    paymentMethodReady: false,
    topUpCheckoutReady: false,
    setupCheckoutReady: false,
    disableReady: false,
    recoverReady: false,
  };
}

function safeRedirect(intent: Stripe.PaymentIntent): boolean {
  const value = intent.next_action?.redirect_to_url?.url;
  if (intent.next_action?.type !== 'redirect_to_url' || !value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function catalogForOffer(
  data: BillingCreditProjectionData,
  offer: { catalogKey: string; catalogVersion: number },
) {
  return data.catalogs.find(
    (catalog) => catalog.key === offer.catalogKey && catalog.version === offer.catalogVersion,
  );
}

async function executableCatalogs(
  stripe: NonNullable<CreditCollectionContext['stripe']>,
  collection: CreditCollectionContext,
  data: BillingCreditProjectionData,
): Promise<Set<string>> {
  const catalogs = new Set<string>();
  const candidates = new Map<string, BillingCreditProjectionData['catalogs'][number]>();
  for (const offer of data.policy?.topUpOffers ?? []) {
    const catalog = catalogForOffer(data, offer);
    if (catalog) candidates.set(catalog.id, catalog);
  }
  await Promise.all(
    [...candidates.values()].map(async (catalog) => {
      try {
        await assertCreditCatalogPrice(stripe, collection.account, catalog);
        catalogs.add(catalog.id);
      } catch {
        // A read remains available; only the action backed by stale remote evidence is frozen.
      }
    }),
  );
  return catalogs;
}

async function currentPaymentMethodReady(
  stripe: NonNullable<CreditCollectionContext['stripe']>,
  collection: CreditCollectionContext,
  data: BillingCreditProjectionData,
): Promise<boolean> {
  const methodId = data.creditAccount.stripePaymentMethodId;
  const customerId = data.creditAccount.customer.stripeCustomerId;
  if (!methodId || !customerId) return false;
  try {
    const method = await stripe.paymentMethods.retrieve(methodId);
    assertStripeObjectLivemode(method, collection.account.livemode);
    return (
      method.id === methodId &&
      method.type === 'card' &&
      Boolean(method.card) &&
      stripeExternalId(method.customer) === customerId
    );
  } catch {
    return false;
  }
}

async function currentRecoveryReady(
  stripe: NonNullable<CreditCollectionContext['stripe']>,
  collection: CreditCollectionContext,
  data: BillingCreditProjectionData,
  selectedCatalogReady: boolean,
  returnUrlsReady: boolean,
): Promise<boolean> {
  const state = data.creditAccount.autoTopUpState;
  if (
    state !== BillingCreditAutoTopUpState.REQUIRES_ACTION &&
    state !== BillingCreditAutoTopUpState.NEEDS_REVIEW &&
    state !== BillingCreditAutoTopUpState.PAUSED
  )
    return false;
  const attempt = data.unresolvedAttempts.at(0);
  if (!attempt) return selectedCatalogReady && returnUrlsReady;
  if (!attempt.stripePaymentIntentId || !data.creditAccount.customer.stripeCustomerId) return false;
  try {
    const intent = await stripe.paymentIntents.retrieve(attempt.stripePaymentIntentId);
    assertStripeObjectLivemode(intent, collection.account.livemode);
    assertCreditFundingMetadata(intent.metadata, {
      localType: 'automatic_top_up',
      localId: attempt.id,
      serviceId: attempt.serviceId,
      appKeyId: attempt.appKeyId,
      creditAccountId: attempt.creditAccountId,
    });
    const exact =
      stripeExternalId(intent.customer) === data.creditAccount.customer.stripeCustomerId &&
      stripeExternalId(intent.payment_method) === attempt.consentRevision.stripePaymentMethodId &&
      exactMinor(intent.amount) === attempt.paymentAmountMinor &&
      requireUsd(intent.currency) === 'USD';
    if (!exact) return false;
    if (intent.status === 'requires_action') return safeRedirect(intent);
    return (
      attempt.status === BillingCreditAutoTopUpAttemptStatus.NEEDS_REVIEW &&
      attempt.stateWebhookEvent?.type === 'payment_intent.payment_failed' &&
      ['requires_payment_method', 'requires_confirmation'].includes(intent.status) &&
      selectedCatalogReady &&
      returnUrlsReady
    );
  } catch {
    return false;
  }
}

export async function resolveBillingCreditActionReadiness(params: {
  collection: CreditCollectionContext;
  credential: VerifiedBillingAppKey;
  data: BillingCreditProjectionData;
}): Promise<BillingCreditActionReadiness> {
  const { collection, credential, data } = params;
  const stripe = collection.stripe;
  if (!collection.stripeCollectionEnabled || !stripe) {
    return unavailableBillingCreditActions();
  }
  let returnUrlsReady = true;
  try {
    pinnedBillingReturnUrls(credential.checkoutReturnOrigins);
  } catch {
    returnUrlsReady = false;
  }
  const catalogs = data.policy
    ? await executableCatalogs(stripe, collection, data)
    : new Set<string>();
  const paymentMethodReady = await currentPaymentMethodReady(stripe, collection, data);
  const selected = data.policy?.autoTopUpOptions.find(
    (option) => option.id === data.creditAccount.autoTopUpOptionId,
  );
  const selectedCatalog = selected ? catalogForOffer(data, selected.refillOffer) : undefined;
  const selectedCatalogReady = Boolean(selectedCatalog && catalogs.has(selectedCatalog.id));
  const unresolvedPayment = data.unresolvedAttempts.some(
    (attempt) =>
      attempt.status === BillingCreditAutoTopUpAttemptStatus.PENDING ||
      attempt.status === BillingCreditAutoTopUpAttemptStatus.PROCESSING ||
      attempt.status === BillingCreditAutoTopUpAttemptStatus.REQUIRES_ACTION ||
      attempt.status === BillingCreditAutoTopUpAttemptStatus.NEEDS_REVIEW,
  );
  return {
    executableCatalogIds: catalogs,
    paymentMethodReady,
    topUpCheckoutReady: returnUrlsReady && data.unresolvedTopUpCheckouts.length === 0,
    setupCheckoutReady:
      returnUrlsReady &&
      data.unresolvedSetupCheckouts.length === 0 &&
      data.unresolvedTopUpCheckouts.length === 0,
    disableReady: !unresolvedPayment,
    recoverReady: await currentRecoveryReady(
      stripe,
      collection,
      data,
      selectedCatalogReady,
      returnUrlsReady,
    ),
  };
}
