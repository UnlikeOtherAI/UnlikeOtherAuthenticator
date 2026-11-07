import { BillingAppKeyPurpose, BillingCreditAutoTopUpState, BillingCreditCheckoutStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { CreditFundingActionContext } from '../../src/services/billing-credit-funding-context.service.js';

export const now = new Date('2026-07-21T12:00:00.000Z');
export const credential = {
  id: 'app_key_deepwater',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://api.deepwater.example',
  actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
  actorKeyId: 'actor_key_1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.deepwater.example'],
  service: { id: 'service_deepwater', identifier: 'deepwater', name: 'DeepWater' },
};
export const request = {
  product: 'deepwater',
  organisationId: 'org_1',
  teamId: 'team_1',
  userId: 'user_1',
};
export const account = { id: 'account_1', stripeAccountId: 'acct_uoa', livemode: false };
export const policy = {
  id: 'policy_1',
  currency: 'USD',
  automaticConsentVersion: 'credits-auto-2026-07',
};
export const offer = {
  id: 'offer_20k',
  paymentAmountMinor: 2_000n,
  creditsReceivedMicrocredits: 20_000_000_000n,
};
export const catalog = {
  id: 'catalog_20k',
  stripePriceId: 'price_20k',
  stripeProductId: 'prod_20k',
  stripeLookupKey: 'credits-20k-v1',
  paymentAmountMinor: offer.paymentAmountMinor,
};
export const option = {
  id: 'option_safe',
  thresholdMicrocredits: 5_000_000_000n,
  monthlyChargeCapMinor: 10_000n,
};

export function fundingMetadata(local: Record<string, string>) {
  return {
    uoa_service_id: credential.service.id,
    uoa_app_key_id: credential.id,
    uoa_credit_account_id: 'credit_account_1',
    ...local,
  };
}

export function baseContext(overrides?: Record<string, unknown>) {
  const sessionsCreate = vi.fn();
  const stripe = {
    checkout: { sessions: { create: sessionsCreate, retrieve: vi.fn(), list: vi.fn() } },
    paymentMethods: { retrieve: vi.fn() },
    paymentIntents: { retrieve: vi.fn(), cancel: vi.fn() },
    prices: { retrieve: vi.fn() },
    accounts: { retrieveCurrent: vi.fn() },
    customers: { create: vi.fn(), retrieve: vi.fn() },
  };
  const creditAccount = {
    id: 'credit_account_1',
    accountId: account.id,
    customerId: 'customer_1',
    orgId: request.organisationId,
    teamId: request.teamId,
    autoTopUpState: BillingCreditAutoTopUpState.DISABLED,
    autoTopUpGeneration: 0,
    autoTopUpOptionId: null,
    autoTopUpConsentRevisionId: null,
    autoTopUpThresholdMicrocredits: null,
    autoTopUpRefillOfferId: null,
    autoTopUpMonthlyChargeCapMinor: null,
    autoTopUpConsentVersion: null,
    autoTopUpConsentedAt: null,
    autoTopUpConsentedByUserId: null,
    stripePaymentMethodId: null,
    paymentMethodSummary: null,
    ...overrides,
  };
  const customer = { id: 'customer_1', stripeCustomerId: 'cus_team_1' };
  const context = {
    actor: { jti: 'actor_jti_1', tv: 0, exp: 2_000_000_000 },
    viewer: { billingManager: true },
    account,
    creditAccount,
    customer,
    stripe,
    authorizeAction: vi.fn(),
    ensureCustomer: vi.fn().mockResolvedValue(customer),
  } as unknown as CreditFundingActionContext;
  return { context, stripe, sessionsCreate };
}

export function selections() {
  return {
    offer: { policy, offer, catalog },
    option: { policy, option, offer, catalog },
  };
}

export function checkoutRow(kind: 'setup' | 'top_up', actorJti = 'actor_jti_1') {
  const returnDigest = (value: string) => createHash('sha256').update(value).digest('hex');
  const common = {
    id: kind === 'top_up' ? 'checkout_topup_1' : 'checkout_setup_1',
    accountId: account.id,
    creditAccountId: 'credit_account_1',
    customerId: 'customer_1',
    serviceId: credential.service.id,
    appKeyId: credential.id,
    actorJti,
    requestedByUserId: request.userId,
    successUrlDigest: returnDigest('https://app.deepwater.example/?uoa_billing=checkout_complete'),
    cancelUrlDigest: returnDigest('https://app.deepwater.example/?uoa_billing=checkout_cancelled'),
    status: BillingCreditCheckoutStatus.CREATING,
    stripeCheckoutSessionId: null,
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
  };
  return kind === 'top_up'
    ? {
        ...common,
        catalogId: catalog.id,
        offerId: offer.id,
        paymentAmountMinor: offer.paymentAmountMinor,
        creditsReceivedMicrocredits: offer.creditsReceivedMicrocredits,
        currency: 'USD',
      }
    : {
        ...common,
        policyId: policy.id,
        optionId: option.id,
        expectedGeneration: 0,
        expectedConsentRevisionId: null,
        consentVersion: policy.automaticConsentVersion,
        thresholdMicrocredits: option.thresholdMicrocredits,
        refillOfferId: offer.id,
        refillCreditsMicrocredits: offer.creditsReceivedMicrocredits,
        refillPaymentAmountMinor: offer.paymentAmountMinor,
        monthlyChargeCapMinor: option.monthlyChargeCapMinor,
      };
}

export function openTopUpSession(
  checkout: ReturnType<typeof checkoutRow> & Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'cs_existing',
    livemode: false,
    mode: 'payment',
    status: 'open',
    url: 'https://checkout.stripe.com/c/pay/cs_existing',
    customer: 'cus_team_1',
    client_reference_id: checkout.id,
    metadata: {
      uoa_credit_top_up_checkout_id: checkout.id,
      uoa_service_id: checkout.serviceId,
      uoa_app_key_id: checkout.appKeyId,
      uoa_credit_account_id: checkout.creditAccountId,
    },
    expires_at: 2_000_000_000,
    ...overrides,
  };
}

