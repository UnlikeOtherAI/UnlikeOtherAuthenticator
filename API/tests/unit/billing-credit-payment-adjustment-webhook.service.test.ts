import { describe, expect, it } from 'vitest';

import { prepareCreditFundingWebhook } from '../../src/services/billing-credit-funding-webhook.service.js';
import {
  fundingPaymentEvent,
  fundingPaymentIntent,
  fundingPreparationDeps,
  fundingStripeAccount,
  paidFundingTopUpCheckout,
} from './billing-credit-funding-webhook.fixtures.js';

describe('credit funding Stripe adjustment webhook preparation', () => {
  it('uses a succeeded refund plus its original paid intent as adjustment evidence', async () => {
    const intent = fundingPaymentIntent({
      uoa_credit_top_up_checkout_id: 'credit_checkout_1',
    });
    const deps = fundingPreparationDeps(intent);
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
    deps.prisma.billingCreditTopUpCheckout.findFirst.mockResolvedValue(paidFundingTopUpCheckout());
    const event = {
      ...fundingPaymentEvent('payment_intent.succeeded', intent),
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
      fundingStripeAccount,
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
    const intent = fundingPaymentIntent({
      uoa_credit_top_up_checkout_id: 'credit_checkout_1',
    });
    const deps = fundingPreparationDeps(intent);
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
          ...fundingPaymentEvent('payment_intent.succeeded', intent),
          id: 'evt_refund_drift',
          type: 'refund.updated',
          data: { object: signed },
        } as never,
        deps.stripe as never,
        fundingStripeAccount,
        deps.prisma as never,
      ),
    ).rejects.toThrow('STRIPE_CREDIT_ADJUSTMENT_STATE_DRIFT');
  });

  it('retries a bound refund until the paid credit projection exists', async () => {
    const intent = fundingPaymentIntent({
      uoa_credit_top_up_checkout_id: 'credit_checkout_1',
    });
    const deps = fundingPreparationDeps(intent);
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
          ...fundingPaymentEvent('payment_intent.succeeded', intent),
          id: 'evt_refund_early',
          type: 'refund.created',
          data: { object: refund },
        } as never,
        deps.stripe as never,
        fundingStripeAccount,
        deps.prisma as never,
      ),
    ).rejects.toThrow('STRIPE_CREDIT_PAYMENT_PROJECTION_PENDING');
  });

  it('ignores unrelated legacy refunds and durably waits for pending refunds', async () => {
    const deps = fundingPreparationDeps();
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
          ...fundingPaymentEvent('payment_intent.succeeded', fundingPaymentIntent()),
          type: 'refund.created',
          data: { object: legacy },
        } as never,
        deps.stripe as never,
        fundingStripeAccount,
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
          ...fundingPaymentEvent('payment_intent.succeeded', fundingPaymentIntent()),
          type: 'refund.created',
          data: { object: pending },
        } as never,
        deps.stripe as never,
        fundingStripeAccount,
        deps.prisma as never,
      ),
    ).resolves.toBeNull();
  });

  it('uses settlement-currency transactions only as exact dispute movement proof', async () => {
    const intent = fundingPaymentIntent({
      uoa_credit_top_up_checkout_id: 'credit_checkout_1',
    });
    const deps = fundingPreparationDeps(intent);
    deps.prisma.billingCreditTopUpCheckout.findFirst.mockResolvedValue(paidFundingTopUpCheckout());
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
        ...fundingPaymentEvent('payment_intent.succeeded', intent),
        id: 'evt_dispute_withdrawn',
        type: 'charge.dispute.funds_withdrawn',
        data: { object: dispute },
      } as never,
      deps.stripe as never,
      fundingStripeAccount,
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
