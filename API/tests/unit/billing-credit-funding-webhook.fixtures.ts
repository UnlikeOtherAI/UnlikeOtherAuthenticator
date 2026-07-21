import { BillingCreditCheckoutStatus } from '@prisma/client';
import { vi } from 'vitest';

export const fundingStripeAccount = {
  id: 'stripe_account_test',
  stripeAccountId: 'acct_uoa',
  livemode: false,
};

export const fundingOccurredAt = new Date('2026-07-21T12:00:00.000Z');

export function fundingMetadata(metadata: Record<string, string>) {
  const bound = Object.keys(metadata).some((key) => key.startsWith('uoa_credit_'));
  return bound
    ? {
        uoa_service_id: 'service_1',
        uoa_app_key_id: 'app_key_1',
        uoa_credit_account_id: 'credit_account_1',
        ...metadata,
      }
    : metadata;
}

export function fundingPaymentIntent(metadata: Record<string, string> = {}) {
  return {
    id: 'pi_credit_1',
    object: 'payment_intent',
    amount: 1000,
    amount_received: 1000,
    created: 1_784_636_400,
    currency: 'usd',
    customer: 'cus_team_1',
    latest_charge: 'ch_credit_1',
    livemode: false,
    metadata: fundingMetadata(metadata),
    payment_method: 'pm_credit_1',
    status: 'succeeded',
  };
}

export function fundingPaymentEvent(
  type: 'payment_intent.payment_failed' | 'payment_intent.succeeded',
  intent: object,
) {
  return {
    id: 'evt_credit_1',
    type,
    api_version: '2026-06-24.dahlia',
    account: 'acct_uoa',
    livemode: false,
    created: Math.floor(fundingOccurredAt.getTime() / 1000),
    data: { object: intent },
  };
}

export function fundingTopUpCheckout() {
  return {
    id: 'credit_checkout_1',
    accountId: fundingStripeAccount.id,
    creditAccountId: 'credit_account_1',
    customerId: 'customer_1',
    serviceId: 'service_1',
    appKeyId: 'app_key_1',
    offerId: 'offer_1',
    actorJti: 'actor_1',
    requestedByUserId: 'user_1',
    paymentAmountMinor: 1000n,
    creditsReceivedMicrocredits: 10_000_000_000n,
    currency: 'USD',
    stripeCheckoutSessionId: 'cs_credit_1',
    stripePaymentIntentId: null,
    status: BillingCreditCheckoutStatus.OPEN,
    customer: { stripeCustomerId: 'cus_team_1' },
  };
}

export function paidFundingTopUpCheckout() {
  return {
    ...fundingTopUpCheckout(),
    status: BillingCreditCheckoutStatus.COMPLETE,
    stripePaymentIntentId: 'pi_credit_1',
    creditEntryId: 'entry_credit_1',
  };
}

export function fundingCheckoutSession(metadata: Record<string, string> = {}) {
  return {
    id: 'cs_credit_1',
    object: 'checkout.session',
    customer: 'cus_team_1',
    expires_at: 1_784_640_000,
    livemode: false,
    metadata: fundingMetadata(metadata),
    mode: 'payment',
    payment_intent: 'pi_credit_1',
    setup_intent: null,
    status: 'complete',
    url: null,
  };
}

export function fundingPreparationDeps(intent = fundingPaymentIntent()) {
  const checkout = fundingTopUpCheckout();
  const session = fundingCheckoutSession({ uoa_credit_top_up_checkout_id: checkout.id });
  return {
    checkout,
    session,
    stripe: {
      checkout: { sessions: { retrieve: vi.fn().mockResolvedValue(session) } },
      disputes: { retrieve: vi.fn() },
      paymentIntents: { retrieve: vi.fn().mockResolvedValue(intent) },
      paymentMethods: { retrieve: vi.fn() },
      refunds: { retrieve: vi.fn() },
      setupIntents: { retrieve: vi.fn() },
    },
    prisma: {
      billingCreditTopUpCheckout: {
        findUnique: vi.fn().mockResolvedValue(checkout),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      billingCreditAutoTopUpAttempt: {
        findUnique: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      billingCreditSetupCheckout: { findUnique: vi.fn() },
    },
  };
}
