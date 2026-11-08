import {
  BillingAppKeyPurpose,
  BillingCreditAutoTopUpState,
  BillingCreditEntryDirection,
  BillingCreditEntryKind,
} from '@prisma/client';



import type { CreditCollectionContext } from '../../src/services/billing-credit-account.service.js';
import type { BillingCreditProjectionData } from '../../src/services/billing-credit-projection-data.service.js';

import type { BillingFundingViewer } from '../../src/services/billing-funding-viewer.service.js';
import {
  CREDIT_AUTO_TOP_UP_SPEC,
  CREDIT_FUNDING_POLICY_SPEC,
  CREDIT_TOP_UP_SPECS,
} from '../../src/services/billing-stripe-catalog-provisioning-spec.js';

export const now = new Date('2026-07-21T12:00:00.000Z');
export const service = { id: 'service_deepwater', identifier: 'deepwater', name: 'DeepWater' };
export const credential = {
  id: 'app_key_deepwater',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://api.deepwater.example',
  actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
  actorKeyId: 'actor_key_1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.deepwater.example'],
  service,
};
export const collection = {
  account: {
    id: 'stripe_account_1',
    stripeAccountId: 'acct_uoa',
    livemode: false,
    createdAt: now,
    updatedAt: now,
  },
  stripeCollectionEnabled: true,
} satisfies CreditCollectionContext;
export const period = {
  key: '2026-07',
  startsAt: new Date('2026-07-01T00:00:00.000Z'),
  endsAt: new Date('2026-08-01T00:00:00.000Z'),
};

export function projectionData(balanceMicrocredits = 2_000_000_000n): BillingCreditProjectionData {
  return {
    creditAccount: {
      id: 'credit_account_1',
      accountId: collection.account.id,
      customerId: 'customer_1',
      currency: 'USD',
      balanceMicrocredits,
      autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
      autoTopUpOptionId: null,
      autoTopUpThresholdMicrocredits: 500_000_000n,
      autoTopUpRefillOfferId: 'offer_refill',
      autoTopUpMonthlyChargeCapMinor: 10_000n,
      autoTopUpConsentVersion: 'credits-v1',
      autoTopUpConsentedAt: now,
      stripePaymentMethodId: 'pm_1',
      paymentMethodSummary: { brand: 'Visa', last4: '4242' },
      autoTopUpConsentedBy: { id: 'user_1', name: 'Viewer' },
    },
    policy: null,
    purchaseCurrency: 'USD',
    reloadCurrency: 'USD',
    regionPolicy: null,
    catalogs: [],
    prepaidReservations: [],
    activeReservedMicrocredits: 0n,
    settlements: [
      {
        id: 'settlement_1',
        serviceId: service.id,
        service,
        cumulativeCreditsConsumedMicrocredits: 500_000_000n,
      },
    ],
    allocations: [
      {
        id: 'allocation_viewer',
        settlementId: 'settlement_1',
        attributedUserId: 'user_1',
        cumulativeCreditsConsumedMicrocredits: 100_000_000n,
        adjustment: { sequence: 1 },
        attributedUser: { id: 'user_1', name: 'Viewer' },
      },
      {
        id: 'allocation_other',
        settlementId: 'settlement_1',
        attributedUserId: 'user_2',
        cumulativeCreditsConsumedMicrocredits: 300_000_000n,
        adjustment: { sequence: 1 },
        attributedUser: { id: 'user_2', name: 'Secret colleague' },
      },
      {
        id: 'allocation_null',
        settlementId: 'settlement_1',
        attributedUserId: null,
        cumulativeCreditsConsumedMicrocredits: 100_000_000n,
        adjustment: { sequence: 1 },
        attributedUser: null,
      },
    ],
    entries: [
      {
        id: 'entry_1',
        occurredAt: now,
        service,
        attributedUserId: 'user_2',
        attributedUser: { id: 'user_2', name: 'Secret colleague' },
        kind: BillingCreditEntryKind.TOP_UP,
        direction: BillingCreditEntryDirection.CREDIT,
        amountMicrocredits: 1_000_000_000n,
        balanceAfterMicrocredits: 2_000_000_000n,
      },
    ],
    periodEntries: [],
    pending: [],
    unresolvedAttempts: [],
    autoTopUpChargedMinor: 0n,
  } as unknown as BillingCreditProjectionData;
}

export function viewer(billingManager: boolean): BillingFundingViewer {
  return {
    userId: 'user_1',
    displayName: 'Viewer',
    organisationId: 'org_1',
    teamId: 'team_1',
    organisationRole: billingManager ? 'admin' : 'member',
    teamRole: 'member',
    billingManager,
  };
}

export function productionFreshAccountData(): BillingCreditProjectionData {
  const data = projectionData(0n);
  Object.assign(data.creditAccount, {
    autoTopUpState: BillingCreditAutoTopUpState.DISABLED,
    autoTopUpOptionId: null,
    autoTopUpThresholdMicrocredits: null,
    autoTopUpRefillOfferId: null,
    autoTopUpMonthlyChargeCapMinor: null,
    autoTopUpConsentRevisionId: null,
    autoTopUpConsentVersion: null,
    autoTopUpConsentedAt: null,
    autoTopUpConsentedBy: null,
    stripePaymentMethodId: null,
    paymentMethodSummary: null,
  });
  data.settlements = [];
  data.allocations = [];
  data.entries = [];
  const offers = CREDIT_TOP_UP_SPECS.filter((spec) => spec.currency === 'USD').map((spec, index) => ({
    id: `offer_${index + 1}`,
    policyId: 'policy_1',
    serviceId: service.id,
    ...spec,
    active: true,
    automaticTopUpEligible: true,
  }));
  const refillOffer = offers.find((offer) => offer.key === CREDIT_AUTO_TOP_UP_SPEC.refillOfferKey);
  if (!refillOffer) throw new Error('Production refill offer fixture is missing');
  data.policy = {
    id: 'policy_1',
    serviceId: service.id,
    ...CREDIT_FUNDING_POLICY_SPEC,
    topUpOffers: offers,
    autoTopUpOptions: [
      {
        id: 'option_default',
        policyId: 'policy_1',
        serviceId: service.id,
        refillOfferId: refillOffer.id,
        ...CREDIT_AUTO_TOP_UP_SPEC,
        refillOffer,
        active: true,
      },
    ],
  } as unknown as NonNullable<BillingCreditProjectionData['policy']>;
  data.catalogs = offers.map((offer, index) => ({
    id: `catalog_${index + 1}`,
    accountId: collection.account.id,
    key: offer.catalogKey,
    version: offer.catalogVersion,
    currency: 'USD',
    paymentAmountMinor: offer.paymentAmountMinor,
    creditsReceivedMicrocredits: offer.creditsReceivedMicrocredits,
    stripeLookupKey: offer.stripeLookupKey,
    stripeProductId: `prod_${index + 1}`,
    stripePriceId: `price_${index + 1}`,
  })) as BillingCreditProjectionData['catalogs'];
  return data;
}

