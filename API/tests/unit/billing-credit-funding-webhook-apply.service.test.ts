import {
  BillingCreditAutoTopUpAttemptStatus,
  BillingCreditAutoTopUpState,
  BillingCreditCheckoutStatus,
} from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { applyCreditFundingWebhook } from '../../src/services/billing-credit-funding-webhook.service.js';
import {
  fundingOccurredAt,
  fundingPaymentIntent,
  fundingStripeAccount,
  fundingTopUpCheckout,
} from './billing-credit-funding-webhook.fixtures.js';

describe('credit funding Stripe webhook application', () => {
  it('locks the shared team balance and credits a paid Checkout exactly once', async () => {
    const checkout = fundingTopUpCheckout();
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
    const intent = fundingPaymentIntent({ uoa_credit_top_up_checkout_id: checkout.id });

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
          occurredAt: fundingOccurredAt,
        },
        eventFields: { stripeCreatedAt: fundingOccurredAt },
      },
      'webhook_event_1',
      fundingStripeAccount,
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

  it('terminalizes definitive failed-payment evidence after an earlier review event', async () => {
    const attemptUpdate = vi.fn();
    const accountUpdate = vi.fn();
    const intent = {
      ...fundingPaymentIntent({ uoa_credit_auto_top_up_attempt_id: 'attempt_1' }),
      status: 'requires_payment_method',
      amount: 1_000,
      amount_received: 0,
      last_payment_error: { code: 'card_declined' },
    };
    const tx = {
      billingCreditAutoTopUpAttempt: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'attempt_1',
          accountId: fundingStripeAccount.id,
          creditAccountId: 'credit_account_1',
          stripePaymentIntentId: intent.id,
          status: BillingCreditAutoTopUpAttemptStatus.NEEDS_REVIEW,
          stateWebhookEventId: 'webhook_earlier_review',
          consentRevision: { stripePaymentMethodId: 'pm_credit_1' },
          creditAccount: { customer: { stripeCustomerId: 'cus_team_1' } },
        }),
        update: attemptUpdate,
      },
      billingCreditAccount: { updateMany: accountUpdate },
    };

    await applyCreditFundingWebhook(
      tx as never,
      {
        event: {
          kind: 'payment_failed',
          localId: 'attempt_1',
          localType: 'automatic_top_up',
          paymentIntent: intent as never,
          paymentMethodId: 'pm_credit_1',
          chargeId: null,
          checkoutSessionId: null,
          occurredAt: fundingOccurredAt,
        },
        eventFields: { stripeCreatedAt: fundingOccurredAt },
      },
      'webhook_definitive_failure',
      fundingStripeAccount,
    );

    expect(attemptUpdate).toHaveBeenCalledWith({
      where: { id: 'attempt_1' },
      data: {
        stripePaymentIntentId: intent.id,
        stateWebhookEventId: 'webhook_definitive_failure',
        status: BillingCreditAutoTopUpAttemptStatus.FAILED,
        failureCode: 'card_declined',
        resolvedAt: fundingOccurredAt,
      },
    });
    expect(accountUpdate).toHaveBeenCalledWith({
      where: {
        id: 'credit_account_1',
        autoTopUpState: { not: BillingCreditAutoTopUpState.DISABLED },
      },
      data: { autoTopUpState: BillingCreditAutoTopUpState.NEEDS_REVIEW },
    });
  });

  it('abandons a late SetupIntent when the consent generation already advanced', async () => {
    const abandon = vi.fn().mockResolvedValue({ count: 1 });
    const revisionCreate = vi.fn();
    const accountUpdate = vi.fn();
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([{ autoTopUpGeneration: 2, autoTopUpConsentRevisionId: 'consent_new' }]),
      billingCreditSetupCheckout: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'setup_stale_1',
          accountId: fundingStripeAccount.id,
          creditAccountId: 'credit_account_1',
          customerId: 'customer_1',
          expectedGeneration: 1,
          expectedConsentRevisionId: 'consent_old',
          stripeCheckoutSessionId: 'cs_setup_stale_1',
          status: BillingCreditCheckoutStatus.OPEN,
          customer: { stripeCustomerId: 'cus_team_1' },
          creditAccount: { orgId: 'org_1', teamId: 'team_1' },
        }),
        updateMany: abandon,
        update: vi.fn(),
      },
      billingCreditAutoTopUpConsentRevision: { create: revisionCreate },
      billingCreditAccount: { updateMany: accountUpdate },
    };

    await applyCreditFundingWebhook(
      tx as never,
      {
        event: {
          kind: 'setup_succeeded',
          localId: 'setup_stale_1',
          setupIntent: {
            id: 'seti_stale_1',
            customer: 'cus_team_1',
          } as never,
          checkoutSessionId: 'cs_setup_stale_1',
          paymentMethodId: 'pm_new',
          paymentMethodSummary: { type: 'card', brand: 'visa', last4: '4242' },
          occurredAt: fundingOccurredAt,
        },
        eventFields: { stripeCreatedAt: fundingOccurredAt },
      },
      'webhook_setup_stale',
      fundingStripeAccount,
    );

    expect(abandon).toHaveBeenCalledWith({
      where: {
        id: 'setup_stale_1',
        status: {
          in: [
            BillingCreditCheckoutStatus.CREATING,
            BillingCreditCheckoutStatus.OPEN,
            BillingCreditCheckoutStatus.NEEDS_REVIEW,
          ],
        },
      },
      data: { status: BillingCreditCheckoutStatus.ABANDONED },
    });
    expect(revisionCreate).not.toHaveBeenCalled();
    expect(accountUpdate).not.toHaveBeenCalled();
  });
});
