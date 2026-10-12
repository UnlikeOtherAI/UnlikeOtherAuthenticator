import { BillingAppKeyPurpose, BillingCreditAutoTopUpState } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { assertBillingCreditsContract } from '../../src/routes/billing/credits.js';
import type { CreditCollectionContext } from '../../src/services/billing-credit-account.service.js';
import type { BillingCreditActionReadiness } from '../../src/services/billing-credit-action-readiness.service.js';
import type { BillingCreditProjectionData } from '../../src/services/billing-credit-projection-data.service.js';
import { buildBillingCreditsProjection } from '../../src/services/billing-credit-projection.service.js';
import type { CreditPurchaseRate } from '../../src/services/billing-credit-purchase-rate.service.js';
import {
  CREDIT_FUNDING_POLICY_SPEC,
  CREDIT_TOP_UP_SPECS,
  creditFundingPolicySpec,
} from '../../src/services/billing-stripe-catalog-provisioning-spec.js';

const now = new Date('2026-10-12T12:00:00.000Z');
const service = { id: 'service_nessie', identifier: 'nessie', name: 'Nessie' };
const credential = {
  id: 'app_key_nessie', purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  checkoutReturnOrigins: ['https://app.nessie.example'], service,
} as unknown as Parameters<typeof buildBillingCreditsProjection>[0]['credential'];
const collection = {
  account: { id: 'stripe_account_1', stripeAccountId: 'acct_uoa', livemode: false, createdAt: now, updatedAt: now },
  stripeCollectionEnabled: true,
} as unknown as CreditCollectionContext;
const period = { key: '2026-10', startsAt: new Date('2026-10-01T00:00:00.000Z'),
  endsAt: new Date('2026-11-01T00:00:00.000Z') };
const viewer = { userId: 'user_1', displayName: 'Manager', organisationId: 'org_eu', teamId: 'team_eu',
  organisationRole: 'admin', teamRole: 'member', billingManager: true } as const;
const rate: CreditPurchaseRate = { currency: 'EUR', source: 'stripe', baseRate: '1.16123', exchangeRate: '1.13844',
  quoteId: 'fxq_live_1', fxSnapshotId: null, asOf: now };

function offersFor(currency: 'USD' | 'EUR', policyId: string) {
  return CREDIT_TOP_UP_SPECS.filter((spec) => spec.currency === currency).map((spec) => ({
    id: `offer_${spec.key}`, policyId, serviceId: service.id, ...spec, active: true, automaticTopUpEligible: true,
  }));
}

function eurData(): BillingCreditProjectionData {
  const usdOffers = offersFor('USD', 'policy_usd');
  const eurOffers = offersFor('EUR', 'policy_eur');
  return {
    creditAccount: {
      id: 'credit_account_eu', accountId: collection.account.id, customerId: 'customer_eu', currency: 'USD',
      balanceMicrocredits: 0n, autoTopUpState: BillingCreditAutoTopUpState.DISABLED, autoTopUpOptionId: null,
      autoTopUpThresholdMicrocredits: null, autoTopUpRefillOfferId: null, autoTopUpMonthlyChargeCapMinor: null,
      autoTopUpConsentVersion: null, autoTopUpConsentedAt: null, autoTopUpConsentedBy: null,
      stripePaymentMethodId: null, paymentMethodSummary: null, customer: { stripeCustomerId: 'cus_eu' },
    },
    policy: { id: 'policy_usd', serviceId: service.id, ...CREDIT_FUNDING_POLICY_SPEC, active: true,
      topUpOffers: usdOffers, autoTopUpOptions: [] },
    purchaseCurrency: 'EUR',
    regionPolicy: { id: 'policy_eur', serviceId: service.id, ...creditFundingPolicySpec('EUR'), active: true,
      topUpOffers: eurOffers },
    catalogs: [...usdOffers, ...eurOffers].map((offer) => ({
      id: `catalog_${offer.key}`, accountId: collection.account.id, key: offer.catalogKey,
      version: offer.catalogVersion, currency: offer.currency, paymentAmountMinor: offer.paymentAmountMinor,
      creditsReceivedMicrocredits: offer.creditsReceivedMicrocredits, stripeLookupKey: offer.stripeLookupKey,
      stripeProductId: 'prod_credits', stripePriceId: `price_${offer.key}`,
    })),
    settlements: [], prepaidReservations: [], activeReservedMicrocredits: 0n, allocations: [], entries: [],
    periodEntries: [], pending: [], unresolvedTopUpCheckouts: [], unresolvedSetupCheckouts: [],
    unresolvedAttempts: [], autoTopUpChargedMinor: 0n,
  } as unknown as BillingCreditProjectionData;
}

function readiness(data: BillingCreditProjectionData): BillingCreditActionReadiness {
  return {
    executableCatalogIds: new Set(data.catalogs.map((catalog) => catalog.id)),
    paymentMethodReady: false, topUpCheckoutReady: true, resumableTopUpOfferId: null,
    setupCheckoutReady: true, disableReady: true, recoverReady: false,
  };
}

function project(data: BillingCreditProjectionData, purchaseRate: CreditPurchaseRate | null,
  locale: 'en-GB' | 'cs' = 'en-GB') {
  const result = buildBillingCreditsProjection({ credential, collection, viewer, period, data, now, locale,
    actionReadiness: readiness(data), purchaseRate });
  if (result.viewer.role !== 'billing_manager' || !result.funding_policy) throw new Error('expected a manager view');
  return result;
}

describe('credit offers in the billing region currency', () => {
  it('prices EUR offers at today\'s rate and says the credits are fixed at checkout', () => {
    const result = project(eurData(), rate);
    const offers = result.funding_policy!.offers;

    expect(offers.map((offer) => offer.key)).toEqual(
      ['credits_eur_10', 'credits_eur_25', 'credits_eur_50', 'credits_eur_100', 'credits_eur_1000']);
    expect(offers[1]).toMatchObject({
      name: 'Medium credit top-up',
      payment_amount: { amount: '25', amount_minor: '2500', currency: 'EUR', display: '€25.00' },
      // EUR 25.00 × 1.16123 = USD 29.03075 → 29,030 whole credits.
      credits_received: { credits: '29030', usd_equivalent: { amount: '29.03', currency: 'USD' } },
      credit_rate: { currency: 'EUR', usd_per_unit: '1.16123', source: 'stripe', as_of: now.toISOString(),
        display: 'At today\'s rate, 1 EUR = 1.1612 USD. Your credits are fixed when you start the payment.' },
      available: true,
    });
    expect(offers[1]?.action?.label).toBe('Buy about 29,030 credits');
    expect(offers[4]).toMatchObject({ name: 'Bulk credit top-up', credits_received: { credits: '1161230' } });
    expect(result.capabilities.can_top_up).toBe(true);
    expect(() => assertBillingCreditsContract(result)).not.toThrow();
  });

  it('leaves the EUR offers out and says why when no rate can be read', () => {
    const result = project(eurData(), null, 'cs');

    expect(result.funding_policy!.offers).toEqual([]);
    expect(result.funding_policy!.description).toContain('Ceny kreditů v EUR teď nejsou dostupné');
    expect(result.capabilities.can_top_up).toBe(false);
    expect(() => assertBillingCreditsContract(result)).not.toThrow();
  });

  it('keeps fixed USD offers with no rate for a USD purchase currency', () => {
    const data = eurData();
    Object.assign(data, { purchaseCurrency: 'USD', regionPolicy: null });

    const offers = project(data, null).funding_policy!.offers;

    expect(offers).toHaveLength(5);
    expect(offers[0]).toMatchObject({ payment_amount: { currency: 'USD' }, credits_received: { credits: '10000' } });
    expect(offers[0]).not.toHaveProperty('credit_rate');
    expect(offers[0]?.action?.label).toBe('Buy 10,000 credits');
  });

  it('shows only the purchase currency\'s pending payment', () => {
    const data = eurData();
    data.pending = [
      { paymentAmountMinor: 2_500n, creditsReceivedMicrocredits: 29_030_000_000n, currency: 'EUR' },
      { paymentAmountMinor: 2_500n, creditsReceivedMicrocredits: 25_000_000_000n, currency: 'USD' },
    ] as unknown as BillingCreditProjectionData['pending'];

    const pending = project(data, rate).pending_credits;

    expect(pending.payment_amount).toMatchObject({ amount_minor: '2500', currency: 'EUR' });
    expect(pending.credits_received.credits).toBe('54030');
    expect(pending.top_up_count).toBe(2);
  });
});
