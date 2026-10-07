import { BillingCreditAutoTopUpState } from '@prisma/client';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { resolveBillingCreditActionReadiness } from '../../src/services/billing-credit-action-readiness.service.js';

const account = { id: 'account_1', stripeAccountId: 'acct_1', livemode: false };
const credential = {
  id: 'app_key_1',
  checkoutReturnOrigins: ['https://app.example'],
  service: { id: 'service_1', identifier: 'deepwater', name: 'DeepWater' },
};
const offer = {
  id: 'offer_1',
  catalogKey: 'credits-20k',
  catalogVersion: 1,
  paymentAmountMinor: 2_000n,
  creditsReceivedMicrocredits: 20_000_000_000n,
};
const catalog = {
  id: 'catalog_1',
  key: offer.catalogKey,
  version: 1,
  stripeLookupKey: 'credits-20k-v1',
  stripePriceId: 'price_1',
  stripeProductId: 'prod_1',
  paymentAmountMinor: offer.paymentAmountMinor,
  creditsReceivedMicrocredits: offer.creditsReceivedMicrocredits,
};

function projectionData(overrides: Record<string, unknown> = {}) {
  return {
    creditAccount: {
      id: 'credit_1',
      customerId: 'customer_1',
      autoTopUpState: BillingCreditAutoTopUpState.DISABLED,
      autoTopUpOptionId: null,
      stripePaymentMethodId: null,
      customer: { stripeCustomerId: 'cus_1' },
      ...overrides,
    },
    policy: { topUpOffers: [offer], autoTopUpOptions: [] },
    catalogs: [catalog],
    unresolvedAttempts: [],
    unresolvedTopUpCheckouts: [],
    unresolvedSetupCheckouts: [],
  };
}

function stripe() {
  return {
    checkout: { sessions: { retrieve: vi.fn() } },
    prices: {
      retrieve: vi.fn().mockResolvedValue({
        id: 'price_1',
        active: true,
        type: 'one_time',
        currency: 'usd',
        unit_amount: 2_000,
        lookup_key: 'credits-20k-v1',
        livemode: false,
        metadata: { credits: '20000', uoa_kind: 'team_credit_top_up' },
        product: {
          id: 'prod_1',
          active: true,
          livemode: false,
          metadata: {
            contract_version: '1',
            credits_per_usd: '1000',
            uoa_kind: 'team_credits',
          },
        },
      }),
    },
    paymentMethods: { retrieve: vi.fn() },
    paymentIntents: { retrieve: vi.fn() },
    products: { retrieve: vi.fn() },
  };
}

function returnDigest(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

function pendingTopUp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'checkout_1',
    accountId: account.id,
    creditAccountId: 'credit_1',
    customerId: 'customer_1',
    catalogId: catalog.id,
    serviceId: credential.service.id,
    appKeyId: credential.id,
    offerId: offer.id,
    paymentAmountMinor: offer.paymentAmountMinor,
    creditsReceivedMicrocredits: offer.creditsReceivedMicrocredits,
    currency: 'USD',
    successUrlDigest: returnDigest('https://app.example/?uoa_billing=checkout_complete'),
    cancelUrlDigest: returnDigest('https://app.example/?uoa_billing=checkout_cancelled'),
    stripeCheckoutSessionId: 'cs_1',
    status: 'OPEN',
    ...overrides,
  };
}

function openTopUpSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_1',
    livemode: false,
    mode: 'payment',
    status: 'open',
    url: 'https://checkout.stripe.com/c/pay/cs_1',
    customer: 'cus_1',
    client_reference_id: 'checkout_1',
    metadata: {
      uoa_credit_top_up_checkout_id: 'checkout_1',
      uoa_service_id: credential.service.id,
      uoa_app_key_id: credential.id,
      uoa_credit_account_id: 'credit_1',
    },
    expires_at: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
}

function recoveryIntent() {
  return {
    id: 'pi_1',
    livemode: false,
    status: 'requires_action',
    amount: 2_000,
    currency: 'usd',
    customer: 'cus_1',
    payment_method: 'pm_1',
    metadata: {
      uoa_credit_auto_top_up_attempt_id: 'attempt_1',
      uoa_service_id: credential.service.id,
      uoa_app_key_id: credential.id,
      uoa_credit_account_id: 'credit_1',
    },
    next_action: {
      type: 'redirect_to_url',
      redirect_to_url: { url: 'https://hooks.stripe.com/recover/pi_1' },
    },
  };
}

describe('credit funding action readiness', () => {
  it('allows managers to turn off future top-ups with an unknown older attempt', async () => {
    const client = stripe();
    const data = projectionData({
      autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
      autoTopUpOptionId: 'option_1',
      stripePaymentMethodId: 'pm_current',
    });
    data.unresolvedAttempts = [
      { id: 'attempt_pending', status: 'PENDING', stripePaymentIntentId: null },
    ] as never;
    client.paymentMethods.retrieve.mockResolvedValue({
      id: 'pm_current',
      livemode: false,
      type: 'card',
      customer: 'cus_1',
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
    });

    const result = await resolveBillingCreditActionReadiness({
      collection: { account, stripeCollectionEnabled: true, stripe: client as never },
      credential: credential as never,
      data: data as never,
    });

    expect(result.disableReady).toBe(true);
  });

  it('uses current active Stripe Price/Product evidence and freezes stale catalog actions', async () => {
    const client = stripe();
    const ready = await resolveBillingCreditActionReadiness({
      collection: { account, stripeCollectionEnabled: true, stripe: client as never },
      credential: credential as never,
      data: projectionData() as never,
    });
    expect(ready.executableCatalogIds.has(catalog.id)).toBe(true);

    client.prices.retrieve.mockResolvedValueOnce({
      id: 'price_1',
      active: false,
      type: 'one_time',
      currency: 'usd',
      unit_amount: 2_000,
      lookup_key: 'credits-20k-v1',
      livemode: false,
      product: { id: 'prod_1', active: true, livemode: false },
    });
    const stale = await resolveBillingCreditActionReadiness({
      collection: { account, stripeCollectionEnabled: true, stripe: client as never },
      credential: credential as never,
      data: projectionData() as never,
    });
    expect(stale.executableCatalogIds.size).toBe(0);
  });

  it('does not touch Stripe and returns all-false readiness behind the collection gate', async () => {
    const client = stripe();
    const result = await resolveBillingCreditActionReadiness({
      collection: { account, stripeCollectionEnabled: false, stripe: client as never },
      credential: credential as never,
      data: projectionData() as never,
    });
    expect(result.executableCatalogIds.size).toBe(0);
    expect(result.recoverReady).toBe(false);
    expect(client.prices.retrieve).not.toHaveBeenCalled();
  });

  it('enables recovery only for an exact current PaymentIntent with a safe HTTPS redirect', async () => {
    const client = stripe();
    client.paymentIntents.retrieve.mockResolvedValue(recoveryIntent());
    const data = projectionData({
      autoTopUpState: BillingCreditAutoTopUpState.REQUIRES_ACTION,
    });
    data.unresolvedAttempts = [
      {
        id: 'attempt_1',
        creditAccountId: 'credit_1',
        serviceId: credential.service.id,
        appKeyId: credential.id,
        stripePaymentIntentId: 'pi_1',
        paymentAmountMinor: 2_000n,
        status: 'REQUIRES_ACTION',
        consentRevision: { stripePaymentMethodId: 'pm_1' },
        stateWebhookEvent: { type: 'payment_intent.requires_action' },
      },
    ] as never;
    const result = await resolveBillingCreditActionReadiness({
      collection: { account, stripeCollectionEnabled: true, stripe: client as never },
      credential: credential as never,
      data: data as never,
    });
    expect(result.recoverReady).toBe(true);

    data.creditAccount.autoTopUpOptionId = 'option_1';
    data.policy.autoTopUpOptions = [{ id: 'option_1', refillOffer: offer }] as never;
    client.paymentIntents.retrieve.mockResolvedValueOnce({
      ...recoveryIntent(),
      next_action: {
        type: 'redirect_to_url',
        redirect_to_url: { url: 'http://unsafe.example/recovery' },
      },
    });
    const replaceableRedirect = await resolveBillingCreditActionReadiness({
      collection: { account, stripeCollectionEnabled: true, stripe: client as never },
      credential: credential as never,
      data: data as never,
    });
    expect(replaceableRedirect.recoverReady).toBe(true);

    client.paymentIntents.retrieve.mockResolvedValueOnce({
      ...recoveryIntent(),
      status: 'canceled',
      next_action: null,
    });
    const canceled = await resolveBillingCreditActionReadiness({
      collection: { account, stripeCollectionEnabled: true, stripe: client as never },
      credential: credential as never,
      data: data as never,
    });
    expect(canceled.recoverReady).toBe(true);

    client.paymentIntents.retrieve.mockResolvedValueOnce({
      ...recoveryIntent(),
      metadata: {
        uoa_credit_auto_top_up_attempt_id: 'attempt_other',
        uoa_service_id: credential.service.id,
        uoa_app_key_id: credential.id,
        uoa_credit_account_id: 'credit_1',
      },
    });
    const rebound = await resolveBillingCreditActionReadiness({
      collection: { account, stripeCollectionEnabled: true, stripe: client as never },
      credential: credential as never,
      data: data as never,
    });
    expect(rebound.recoverReady).toBe(false);
  });

  it('keeps non-redirect disable evidence independent from policy and return URL drift', async () => {
    const client = stripe();
    const data = projectionData({
      autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
      autoTopUpOptionId: 'option_removed',
      stripePaymentMethodId: 'pm_1',
    });
    data.policy = null as never;
    client.paymentMethods.retrieve.mockResolvedValue({
      id: 'pm_1',
      livemode: false,
      type: 'card',
      card: { brand: 'visa', last4: '4242' },
      customer: 'cus_1',
    });

    const result = await resolveBillingCreditActionReadiness({
      collection: { account, stripeCollectionEnabled: true, stripe: client as never },
      credential: { ...credential, checkoutReturnOrigins: [] } as never,
      data: data as never,
    });

    expect(result.paymentMethodReady).toBe(true);
    expect(result.disableReady).toBe(true);
    expect(result.topUpCheckoutReady).toBe(false);
    expect(result.setupCheckoutReady).toBe(false);
  });

  it('classifies payment-card expiry through the UTC valid-through month and enables replacement', async () => {
    const client = stripe();
    const data = projectionData({
      autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
      autoTopUpOptionId: 'option_1',
      stripePaymentMethodId: 'pm_current',
    });
    data.policy.autoTopUpOptions = [{ id: 'option_1', refillOffer: offer }] as never;
    client.paymentMethods.retrieve.mockResolvedValue({
      id: 'pm_current',
      livemode: false,
      type: 'card',
      customer: 'cus_1',
      card: { brand: 'visa', last4: '4242', exp_month: 9, exp_year: 2026 },
    });

    const expired = await resolveBillingCreditActionReadiness({
      collection: { account, stripeCollectionEnabled: true, stripe: client as never },
      credential: credential as never,
      data: data as never,
      now: new Date('2026-10-01T00:15:00.000Z'),
    });

    expect(expired).toMatchObject({
      paymentMethodReady: false,
      paymentMethodVerified: true,
      paymentMethodExpired: true,
      paymentMethodSummary: { brand: 'visa', last4: '4242' },
      recoverReady: true,
    });

    client.paymentMethods.retrieve.mockResolvedValueOnce({
      id: 'pm_current',
      livemode: false,
      type: 'card',
      customer: 'cus_1',
      card: { brand: 'mastercard', last4: '1881', exp_month: 10, exp_year: 2026 },
    });
    const validThroughCurrentMonth = await resolveBillingCreditActionReadiness({
      collection: { account, stripeCollectionEnabled: true, stripe: client as never },
      credential: credential as never,
      data: data as never,
      now: new Date('2026-10-31T23:59:59.999Z'),
    });
    expect(validThroughCurrentMonth).toMatchObject({
      paymentMethodReady: true,
      paymentMethodExpired: false,
      paymentMethodSummary: { brand: 'mastercard', last4: '1881' },
      recoverReady: true,
    });
  });

  it('does not infer card expiry or offer replacement when the fresh Stripe read fails', async () => {
    const client = stripe();
    client.paymentMethods.retrieve.mockRejectedValue(new Error('Stripe unavailable'));
    const data = projectionData({
      autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
      autoTopUpOptionId: 'option_1',
      stripePaymentMethodId: 'pm_current',
    });
    data.policy.autoTopUpOptions = [{ id: 'option_1', refillOffer: offer }] as never;

    const result = await resolveBillingCreditActionReadiness({
      collection: { account, stripeCollectionEnabled: true, stripe: client as never },
      credential: credential as never,
      data: data as never,
      now: new Date('2026-10-01T00:15:00.000Z'),
    });

    expect(result).toMatchObject({
      paymentMethodReady: false,
      paymentMethodVerified: false,
      paymentMethodExpired: false,
      recoverReady: false,
    });
  });

  it('resumes only one exactly bound, current open top-up Checkout', async () => {
    const client = stripe();
    client.checkout.sessions.retrieve.mockResolvedValue(openTopUpSession());
    const data = projectionData();
    data.unresolvedTopUpCheckouts = [pendingTopUp()] as never;

    const result = await resolveBillingCreditActionReadiness({
      collection: { account, stripeCollectionEnabled: true, stripe: client as never },
      credential: credential as never,
      data: data as never,
    });

    expect(result.resumableTopUpOfferId).toBe(offer.id);
    expect(result.topUpCheckoutReady).toBe(false);
    expect(client.checkout.sessions.retrieve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another account', { accountId: 'account_other' }],
    ['another credit account', { creditAccountId: 'credit_other' }],
    ['another customer', { customerId: 'customer_other' }],
    ['another catalog', { catalogId: 'catalog_other' }],
    ['another service', { serviceId: 'service_other' }],
    ['another app key', { appKeyId: 'app_key_other' }],
    ['another offer', { offerId: 'offer_other' }],
    ['changed payment amount', { paymentAmountMinor: 2_001n }],
    ['changed credit quantity', { creditsReceivedMicrocredits: 20_000_000_001n }],
    ['changed success return URL', { successUrlDigest: 'e'.repeat(64) }],
    ['changed cancel return URL', { cancelUrlDigest: 'f'.repeat(64) }],
  ])('blocks a pending checkout with %s binding drift', async (_label, overrides) => {
    const client = stripe();
    const data = projectionData();
    data.unresolvedTopUpCheckouts = [pendingTopUp(overrides)] as never;

    const result = await resolveBillingCreditActionReadiness({
      collection: { account, stripeCollectionEnabled: true, stripe: client as never },
      credential: credential as never,
      data: data as never,
    });

    expect(result.resumableTopUpOfferId).toBeNull();
    expect(result.topUpCheckoutReady).toBe(false);
    expect(client.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', 'expired', null, true],
    ['complete', 'complete', null, false],
  ])(
    'does not hand out a stale redirect for a %s Stripe snapshot',
    async (_label, status, url, ready) => {
      const client = stripe();
      client.checkout.sessions.retrieve.mockResolvedValue(openTopUpSession({ status, url }));
      const data = projectionData();
      data.unresolvedTopUpCheckouts = [pendingTopUp()] as never;

      const result = await resolveBillingCreditActionReadiness({
        collection: { account, stripeCollectionEnabled: true, stripe: client as never },
        credential: credential as never,
        data: data as never,
      });

      expect(result.resumableTopUpOfferId).toBeNull();
      expect(result.topUpCheckoutReady).toBe(ready);
    },
  );

  it('keeps an exact pending checkout blocking offers when Stripe cannot confirm it', async () => {
    const client = stripe();
    client.checkout.sessions.retrieve.mockRejectedValue(new Error('Stripe unavailable'));
    const data = projectionData();
    data.unresolvedTopUpCheckouts = [pendingTopUp()] as never;

    const result = await resolveBillingCreditActionReadiness({
      collection: { account, stripeCollectionEnabled: true, stripe: client as never },
      credential: credential as never,
      data: data as never,
    });

    expect(result.resumableTopUpOfferId).toBeNull();
    expect(result.topUpCheckoutReady).toBe(false);
  });
});
