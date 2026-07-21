import { BillingCreditCheckoutStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  applyCreditFundingWebhook,
  prepareCreditFundingWebhook,
} from '../../src/services/billing-credit-funding-webhook.service.js';

const account = { id: 'stripe_account_test', stripeAccountId: 'acct_uoa', livemode: false };
const occurredAt = new Date('2026-07-21T12:00:00.000Z');

function paymentIntent(metadata: Record<string, string> = {}) {
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
    metadata,
    payment_method: 'pm_credit_1',
    status: 'succeeded',
  };
}

function paymentEvent(type: 'payment_intent.payment_failed' | 'payment_intent.succeeded', intent: object) {
  return {
    id: 'evt_credit_1',
    type,
    api_version: '2026-06-24.dahlia',
    account: 'acct_uoa',
    livemode: false,
    created: Math.floor(occurredAt.getTime() / 1000),
    data: { object: intent },
  };
}

function topUpCheckout() {
  return {
    id: 'credit_checkout_1',
    accountId: account.id,
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

function paidTopUpCheckout() {
  return {
    ...topUpCheckout(),
    status: BillingCreditCheckoutStatus.COMPLETE,
    stripePaymentIntentId: 'pi_credit_1',
    creditEntryId: 'entry_credit_1',
  };
}

function checkoutSession(metadata: Record<string, string> = {}) {
  return {
    id: 'cs_credit_1',
    object: 'checkout.session',
    customer: 'cus_team_1',
    expires_at: 1_784_640_000,
    livemode: false,
    metadata,
    mode: 'payment',
    payment_intent: 'pi_credit_1',
    setup_intent: null,
    status: 'complete',
    url: null,
  };
}

function preparationDeps(intent = paymentIntent()) {
  const checkout = topUpCheckout();
  const session = checkoutSession({ uoa_credit_top_up_checkout_id: checkout.id });
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
      metadata: { uoa_credit_setup_checkout_id: 'setup_checkout_1' },
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
      metadata: { uoa_credit_setup_checkout_id: 'setup_checkout_1' },
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

  it('uses a succeeded refund plus its original paid intent as adjustment evidence', async () => {
    const intent = paymentIntent({ uoa_credit_top_up_checkout_id: 'credit_checkout_1' });
    const deps = preparationDeps(intent);
    deps.stripe.refunds.retrieve.mockResolvedValue({
      id: 're_credit_1',
      object: 'refund',
      amount: 250,
      charge: 'ch_credit_1',
      created: 1_784_636_300,
      currency: 'usd',
      metadata: {},
      payment_intent: intent.id,
      status: 'succeeded',
    });
    deps.prisma.billingCreditTopUpCheckout.findFirst.mockResolvedValue(
      paidTopUpCheckout(),
    );
    const event = {
      ...paymentEvent('payment_intent.succeeded', intent),
      id: 'evt_refund_1',
      type: 'refund.updated',
      data: {
        object: {
          id: 're_credit_1',
          amount: 250,
          charge: 'ch_credit_1',
          currency: 'usd',
          payment_intent: intent.id,
          status: 'succeeded',
        },
      },
    };

    const prepared = await prepareCreditFundingWebhook(
      event as never,
      deps.stripe as never,
      account,
      deps.prisma as never,
    );

    expect(prepared).toMatchObject({
      event: {
        kind: 'payment_adjustment',
        localId: 'credit_checkout_1',
        stripeObjectId: 're_credit_1',
        amountMinor: 250n,
      },
      eventFields: {
        stripeObjectId: 're_credit_1',
        stripePaymentIntentId: 'pi_credit_1',
        stripeChargeId: 'ch_credit_1',
        amountMinor: 250n,
      },
    });
  });

  it('retries when immutable refund payment evidence drifts', async () => {
    const intent = paymentIntent({ uoa_credit_top_up_checkout_id: 'credit_checkout_1' });
    const deps = preparationDeps(intent);
    const signed = {
      id: 're_credit_drift',
      object: 'refund',
      amount: 250,
      charge: 'ch_credit_1',
      currency: 'usd',
      payment_intent: intent.id,
      status: 'succeeded',
    };
    deps.stripe.refunds.retrieve.mockResolvedValue({ ...signed, amount: 500 });

    await expect(
      prepareCreditFundingWebhook(
        {
          ...paymentEvent('payment_intent.succeeded', intent),
          id: 'evt_refund_drift',
          type: 'refund.updated',
          data: { object: signed },
        } as never,
        deps.stripe as never,
        account,
        deps.prisma as never,
      ),
    ).rejects.toThrow('STRIPE_CREDIT_ADJUSTMENT_STATE_DRIFT');
  });

  it('retries a bound refund until the paid credit projection exists', async () => {
    const intent = paymentIntent({ uoa_credit_top_up_checkout_id: 'credit_checkout_1' });
    const deps = preparationDeps(intent);
    const refund = {
      id: 're_credit_early',
      object: 'refund',
      amount: 1000,
      charge: 'ch_credit_1',
      currency: 'usd',
      payment_intent: intent.id,
      status: 'succeeded',
    };
    deps.stripe.refunds.retrieve.mockResolvedValue(refund);

    await expect(
      prepareCreditFundingWebhook(
        {
          ...paymentEvent('payment_intent.succeeded', intent),
          id: 'evt_refund_early',
          type: 'refund.created',
          data: { object: refund },
        } as never,
        deps.stripe as never,
        account,
        deps.prisma as never,
      ),
    ).rejects.toThrow('STRIPE_CREDIT_PAYMENT_PROJECTION_PENDING');
  });

  it('ignores unrelated legacy refunds and durably waits for pending refunds', async () => {
    const deps = preparationDeps();
    const legacy = {
      id: 're_legacy',
      object: 'refund',
      amount: 100,
      charge: 'ch_legacy',
      currency: 'usd',
      payment_intent: null,
      status: 'succeeded',
    };
    deps.stripe.refunds.retrieve.mockResolvedValueOnce(legacy);
    await expect(
      prepareCreditFundingWebhook(
        {
          ...paymentEvent('payment_intent.succeeded', paymentIntent()),
          type: 'refund.created',
          data: { object: legacy },
        } as never,
        deps.stripe as never,
        account,
        deps.prisma as never,
      ),
    ).resolves.toBeNull();

    const pending = {
      ...legacy,
      id: 're_pending',
      payment_intent: 'pi_credit_1',
      charge: 'ch_credit_1',
      status: 'pending',
    };
    deps.stripe.refunds.retrieve.mockResolvedValueOnce(pending);
    await expect(
      prepareCreditFundingWebhook(
        {
          ...paymentEvent('payment_intent.succeeded', paymentIntent()),
          type: 'refund.created',
          data: { object: pending },
        } as never,
        deps.stripe as never,
        account,
        deps.prisma as never,
      ),
    ).resolves.toBeNull();
  });

  it('uses settlement-currency balance transactions only as exact dispute movement proof', async () => {
    const intent = paymentIntent({ uoa_credit_top_up_checkout_id: 'credit_checkout_1' });
    const deps = preparationDeps(intent);
    deps.prisma.billingCreditTopUpCheckout.findFirst.mockResolvedValue(
      paidTopUpCheckout(),
    );
    const dispute = {
      id: 'dp_credit_1',
      object: 'dispute',
      amount: 1000,
      balance_transactions: [
        {
          id: 'txn_dispute_gbp',
          amount: -400,
          currency: 'gbp',
          exchange_rate: 0.8,
        },
      ],
      charge: 'ch_credit_1',
      currency: 'usd',
      livemode: false,
      payment_intent: intent.id,
      status: 'needs_response',
    };
    deps.stripe.disputes.retrieve.mockResolvedValue(dispute);
    const prepared = await prepareCreditFundingWebhook(
      {
        ...paymentEvent('payment_intent.succeeded', intent),
        id: 'evt_dispute_withdrawn',
        type: 'charge.dispute.funds_withdrawn',
        data: { object: dispute },
      } as never,
      deps.stripe as never,
      account,
      deps.prisma as never,
    );

    expect(prepared).toMatchObject({
      event: {
        adjustmentKind: 'DISPUTE',
        amountMinor: 500n,
      },
      eventFields: { amountMinor: 500n, currency: 'USD' },
    });
  });
});

describe('credit funding Stripe webhook application', () => {
  it('locks the shared team balance and credits a paid Checkout exactly once', async () => {
    const checkout = topUpCheckout();
    const entryCreate = vi.fn().mockResolvedValue({ id: 'entry_1' });
    const checkoutUpdate = vi.fn().mockResolvedValue({});
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ balanceMicrocredits: 5_000_000_000n }]),
      billingCreditTopUpCheckout: {
        findUnique: vi.fn().mockResolvedValue(checkout),
        update: checkoutUpdate,
      },
      billingCreditEntry: { create: entryCreate },
    };
    const intent = paymentIntent({ uoa_credit_top_up_checkout_id: checkout.id });

    await applyCreditFundingWebhook(
      tx as never,
      {
        event: {
          kind: 'payment_succeeded',
          localId: checkout.id,
          localType: 'top_up',
          paymentIntent: intent as never,
          paymentMethodId: 'pm_credit_1',
          chargeId: 'ch_credit_1',
          checkoutSessionId: 'cs_credit_1',
          occurredAt,
        },
        eventFields: { stripeCreatedAt: occurredAt },
      },
      'webhook_event_1',
      account,
    );

    expect(entryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        creditAccountId: 'credit_account_1',
        kind: 'TOP_UP',
        amountMicrocredits: 10_000_000_000n,
        balanceAfterMicrocredits: 15_000_000_000n,
        sourceId: checkout.id,
      }),
    });
    expect(checkoutUpdate).toHaveBeenCalledWith({
      where: { id: checkout.id },
      data: expect.objectContaining({
        status: 'COMPLETE',
        stripePaymentIntentId: intent.id,
        completionWebhookEventId: 'webhook_event_1',
      }),
    });
    expect(entryCreate.mock.invocationCallOrder[0]).toBeLessThan(
      checkoutUpdate.mock.invocationCallOrder[0],
    );
  });
});
