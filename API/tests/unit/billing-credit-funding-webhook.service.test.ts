import { describe, expect, it } from 'vitest';

import { prepareCreditFundingWebhook } from '../../src/services/billing-credit-funding-webhook.service.js';
import {
  fundingCheckoutSession,
  fundingMetadata,
  fundingOccurredAt,
  fundingPaymentEvent,
  fundingPaymentIntent,
  fundingPreparationDeps,
  fundingStripeAccount,
} from './billing-credit-funding-webhook.fixtures.js';

const account = fundingStripeAccount;
const paymentIntent = fundingPaymentIntent;
const paymentEvent = fundingPaymentEvent;
const preparationDeps = fundingPreparationDeps;
const checkoutSession = fundingCheckoutSession;
const occurredAt = fundingOccurredAt;

describe('credit funding Stripe webhook preparation', () => {
  it('persists exact Checkout, customer, payment, and amount facts for a paid top-up', async () => {
    const intent = paymentIntent({ uoa_credit_top_up_checkout_id: 'credit_checkout_1' });
    const deps = preparationDeps(intent);
    const prepared = await prepareCreditFundingWebhook(
      paymentEvent('payment_intent.succeeded', intent) as never,
      deps.stripe as never,
      account,
      deps.prisma as never,
    );

    expect(prepared).toMatchObject({
      event: {
        kind: 'payment_succeeded',
        localId: 'credit_checkout_1',
        localType: 'top_up',
        checkoutSessionId: 'cs_credit_1',
      },
      eventFields: {
        stripeObjectId: 'pi_credit_1',
        stripeCustomerId: 'cus_team_1',
        stripeCheckoutSessionId: 'cs_credit_1',
        stripePaymentIntentId: 'pi_credit_1',
        stripeChargeId: 'ch_credit_1',
        stripePaymentMethodId: 'pm_credit_1',
        amountMinor: 1000n,
        currency: 'USD',
        stripeCreatedAt: occurredAt,
      },
    });
  });

  it('ignores unrelated PaymentIntents and rejects ambiguous UOA metadata', async () => {
    const unrelated = preparationDeps(paymentIntent());
    await expect(
      prepareCreditFundingWebhook(
        paymentEvent('payment_intent.succeeded', paymentIntent()) as never,
        unrelated.stripe as never,
        account,
        unrelated.prisma as never,
      ),
    ).resolves.toBeNull();

    const malformedIntent = paymentIntent({
      uoa_credit_top_up_checkout_id: 'credit_checkout_1',
      uoa_credit_auto_top_up_attempt_id: 'attempt_1',
    });
    const malformed = preparationDeps(malformedIntent);
    await expect(
      prepareCreditFundingWebhook(
        paymentEvent('payment_intent.succeeded', malformedIntent) as never,
        malformed.stripe as never,
        account,
        malformed.prisma as never,
      ),
    ).rejects.toThrow('STRIPE_CREDIT_METADATA_INVALID');
  });

  it.each([
    {
      name: 'removed',
      signed: { uoa_credit_top_up_checkout_id: 'credit_checkout_1' },
      current: {},
    },
    {
      name: 'added after signing',
      signed: {},
      current: { uoa_credit_top_up_checkout_id: 'credit_checkout_1' },
    },
    {
      name: 'rebound',
      signed: { uoa_credit_top_up_checkout_id: 'credit_checkout_1' },
      current: { uoa_credit_top_up_checkout_id: 'credit_checkout_2' },
    },
  ])('retries when PaymentIntent UOA binding metadata was $name', async ({ signed, current }) => {
    const signedIntent = paymentIntent(signed);
    const deps = preparationDeps(paymentIntent(current));

    await expect(
      prepareCreditFundingWebhook(
        paymentEvent('payment_intent.succeeded', signedIntent) as never,
        deps.stripe as never,
        account,
        deps.prisma as never,
      ),
    ).rejects.toThrow('STRIPE_CREDIT_BINDING_STATE_DRIFT');
    expect(deps.prisma.billingCreditTopUpCheckout.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    { field: 'amount', current: { amount: 2000 } },
    { field: 'currency', current: { currency: 'gbp' } },
    { field: 'customer', current: { customer: 'cus_other' } },
    { field: 'payment method', current: { payment_method: 'pm_other' } },
    { field: 'charge', current: { latest_charge: 'ch_other' } },
  ])('retries when immutable PaymentIntent $field evidence drifts', async ({ current }) => {
    const metadata = { uoa_credit_top_up_checkout_id: 'credit_checkout_1' };
    const signedIntent = paymentIntent(metadata);
    const deps = preparationDeps({ ...paymentIntent(metadata), ...current });

    await expect(
      prepareCreditFundingWebhook(
        paymentEvent('payment_intent.succeeded', signedIntent) as never,
        deps.stripe as never,
        account,
        deps.prisma as never,
      ),
    ).rejects.toThrow('STRIPE_CREDIT_BINDING_STATE_DRIFT');
  });

  it('retries when a signed SetupIntent loses its UOA binding metadata', async () => {
    const signed = {
      id: 'seti_credit_1',
      customer: 'cus_team_1',
      livemode: false,
      metadata: fundingMetadata({ uoa_credit_setup_checkout_id: 'setup_checkout_1' }),
      payment_method: 'pm_credit_1',
      status: 'succeeded',
      usage: 'off_session',
    };
    const deps = preparationDeps();
    deps.stripe.setupIntents.retrieve.mockResolvedValue({ ...signed, metadata: {} });

    await expect(
      prepareCreditFundingWebhook(
        {
          ...paymentEvent('payment_intent.succeeded', paymentIntent()),
          id: 'evt_setup_1',
          type: 'setup_intent.succeeded',
          data: { object: signed },
        } as never,
        deps.stripe as never,
        account,
        deps.prisma as never,
      ),
    ).rejects.toThrow('STRIPE_CREDIT_BINDING_STATE_DRIFT');
    expect(deps.prisma.billingCreditSetupCheckout.findUnique).not.toHaveBeenCalled();
  });

  it('retries when immutable SetupIntent payment evidence drifts', async () => {
    const signed = {
      id: 'seti_credit_1',
      customer: 'cus_team_1',
      livemode: false,
      metadata: fundingMetadata({ uoa_credit_setup_checkout_id: 'setup_checkout_1' }),
      payment_method: 'pm_credit_1',
      status: 'succeeded',
      usage: 'off_session',
    };
    const deps = preparationDeps();
    deps.stripe.setupIntents.retrieve.mockResolvedValue({
      ...signed,
      payment_method: 'pm_other',
    });

    await expect(
      prepareCreditFundingWebhook(
        {
          ...paymentEvent('payment_intent.succeeded', paymentIntent()),
          id: 'evt_setup_drift',
          type: 'setup_intent.succeeded',
          data: { object: signed },
        } as never,
        deps.stripe as never,
        account,
        deps.prisma as never,
      ),
    ).rejects.toThrow('STRIPE_CREDIT_BINDING_STATE_DRIFT');
  });

  it('retries when an expired credit Checkout loses its signed UOA binding metadata', async () => {
    const signed = {
      ...checkoutSession({ uoa_credit_top_up_checkout_id: 'credit_checkout_1' }),
      status: 'expired',
    };
    const deps = preparationDeps();
    deps.stripe.checkout.sessions.retrieve.mockResolvedValue({ ...signed, metadata: {} });

    await expect(
      prepareCreditFundingWebhook(
        {
          ...paymentEvent('payment_intent.succeeded', paymentIntent()),
          id: 'evt_checkout_expired_1',
          type: 'checkout.session.expired',
          data: { object: signed },
        } as never,
        deps.stripe as never,
        account,
        deps.prisma as never,
      ),
    ).rejects.toThrow('STRIPE_CREDIT_BINDING_STATE_DRIFT');
  });
});
