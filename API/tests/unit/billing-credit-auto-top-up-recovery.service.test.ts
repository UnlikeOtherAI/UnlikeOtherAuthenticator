import {
  BillingAppKeyPurpose,
  BillingCreditAutoTopUpAttemptStatus,
  BillingCreditAutoTopUpState,
  type PrismaClient,
} from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { recoverBillingCreditAutoTopUp } from '../../src/services/billing-credit-auto-top-up-recovery.service.js';
import type { CreditFundingActionContext } from '../../src/services/billing-credit-funding-context.service.js';

const credential = {
  id: 'app_key_deepwater',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  checkoutReturnOrigins: ['https://app.deepwater.example'],
  service: { id: 'service_deepwater', identifier: 'deepwater', name: 'DeepWater' },
};
const request = {
  product: 'deepwater',
  organisationId: 'org_1',
  teamId: 'team_1',
  userId: 'user_1',
};

function fundingMetadata(attemptId: string) {
  return {
    uoa_credit_auto_top_up_attempt_id: attemptId,
    uoa_service_id: credential.service.id,
    uoa_app_key_id: credential.id,
    uoa_credit_account_id: 'credit_account_1',
  };
}

function recoveryContext(
  state: BillingCreditAutoTopUpState,
  autoTopUpOptionId: string | null = null,
) {
  const stripe = {
    paymentIntents: { retrieve: vi.fn(), cancel: vi.fn() },
  };
  return {
    stripe,
    context: {
      actor: { jti: 'actor_jti_1' },
      viewer: { billingManager: true },
      account: { id: 'account_1', stripeAccountId: 'acct_uoa', livemode: false },
      creditAccount: {
        id: 'credit_account_1',
        autoTopUpState: state,
        autoTopUpOptionId,
      },
      customer: { id: 'customer_1', stripeCustomerId: 'cus_team_1' },
      stripe,
    } as unknown as CreditFundingActionContext,
  };
}

function unresolvedAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: 'attempt_1',
    creditAccountId: 'credit_account_1',
    serviceId: credential.service.id,
    appKeyId: credential.id,
    stripePaymentIntentId: 'pi_auto_1',
    paymentAmountMinor: 2_000n,
    consentRevision: { stripePaymentMethodId: 'pm_1' },
    ...overrides,
  };
}

describe('automatic credit top-up recovery', () => {
  it('returns only the exact bound HTTPS PaymentIntent recovery URL', async () => {
    const state = recoveryContext(BillingCreditAutoTopUpState.REQUIRES_ACTION);
    const intent = {
      id: 'pi_auto_1',
      livemode: false,
      status: 'requires_action',
      amount: 2_000,
      currency: 'usd',
      customer: 'cus_team_1',
      payment_method: 'pm_1',
      metadata: fundingMetadata('attempt_1'),
      next_action: {
        type: 'redirect_to_url',
        redirect_to_url: { url: 'https://hooks.stripe.com/redirect/authenticate/pi_auto_1' },
      },
    };
    state.stripe.paymentIntents.retrieve.mockResolvedValue(intent);
    const prisma = {
      billingCreditAutoTopUpAttempt: {
        findFirst: vi.fn().mockResolvedValue(unresolvedAttempt()),
      },
    } as unknown as PrismaClient;

    await expect(
      recoverBillingCreditAutoTopUp(
        { request, actorToken: 'actor', credential },
        { prisma, resolveContext: vi.fn().mockResolvedValue(state.context) },
      ),
    ).resolves.toEqual({
      redirect_url: 'https://hooks.stripe.com/redirect/authenticate/pi_auto_1',
    });

    intent.amount = Number.MAX_SAFE_INTEGER + 1;
    await expect(
      recoverBillingCreditAutoTopUp(
        { request, actorToken: 'actor', credential },
        { prisma, resolveContext: vi.fn().mockResolvedValue(state.context) },
      ),
    ).rejects.toThrow('STRIPE_CREDIT_AMOUNT_INVALID');
  });

  it('rejects recovery when Stripe metadata is rebound to another attempt', async () => {
    const state = recoveryContext(BillingCreditAutoTopUpState.REQUIRES_ACTION);
    state.stripe.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_auto_1',
      livemode: false,
      status: 'requires_action',
      amount: 2_000,
      currency: 'usd',
      customer: 'cus_team_1',
      payment_method: 'pm_1',
      metadata: fundingMetadata('attempt_attacker'),
      next_action: {
        type: 'redirect_to_url',
        redirect_to_url: { url: 'https://attacker.example/recovery' },
      },
    });
    const prisma = {
      billingCreditAutoTopUpAttempt: {
        findFirst: vi.fn().mockResolvedValue(unresolvedAttempt()),
      },
    } as unknown as PrismaClient;

    await expect(
      recoverBillingCreditAutoTopUp(
        { request, actorToken: 'actor', credential },
        { prisma, resolveContext: vi.fn().mockResolvedValue(state.context) },
      ),
    ).rejects.toThrow('STRIPE_CREDIT_AUTO_TOP_UP_BINDING_INVALID');
  });

  it('cancels and terminalizes exact replaceable failure evidence before replacement setup', async () => {
    const state = recoveryContext(BillingCreditAutoTopUpState.NEEDS_REVIEW, 'option_safe');
    const intent = {
      id: 'pi_replaceable_1',
      livemode: false,
      status: 'requires_payment_method',
      amount: 2_000,
      currency: 'usd',
      customer: 'cus_team_1',
      payment_method: 'pm_1',
      metadata: fundingMetadata('attempt_failed_1'),
    };
    state.stripe.paymentIntents.retrieve.mockResolvedValue(intent);
    state.stripe.paymentIntents.cancel.mockResolvedValue({ ...intent, status: 'canceled' });
    const terminalize = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      billingCreditAutoTopUpAttempt: {
        findFirst: vi.fn().mockResolvedValue(
          unresolvedAttempt({
            id: 'attempt_failed_1',
            stripePaymentIntentId: intent.id,
            status: BillingCreditAutoTopUpAttemptStatus.NEEDS_REVIEW,
            failureCode: 'card_declined',
            stateWebhookEventId: 'webhook_failed_1',
            stateWebhookEvent: { type: 'payment_intent.payment_failed' },
          }),
        ),
        updateMany: terminalize,
      },
    } as unknown as PrismaClient;
    const createSetup = vi.fn().mockResolvedValue({
      redirect_url: 'https://checkout.stripe.com/c/pay/replacement',
    });

    const result = await recoverBillingCreditAutoTopUp(
      { request, actorToken: 'actor', credential },
      {
        prisma,
        resolveContext: vi.fn().mockResolvedValue(state.context),
        createSetup,
      },
    );

    expect(state.stripe.paymentIntents.cancel).toHaveBeenCalledWith(intent.id);
    expect(terminalize).toHaveBeenCalledWith({
      where: {
        id: 'attempt_failed_1',
        status: BillingCreditAutoTopUpAttemptStatus.NEEDS_REVIEW,
        stateWebhookEventId: { not: null },
      },
      data: {
        status: BillingCreditAutoTopUpAttemptStatus.FAILED,
        failureCode: 'card_declined',
        resolvedAt: expect.any(Date),
      },
    });
    expect(createSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ optionId: 'option_safe' }),
        recovery: true,
      }),
      { prisma },
    );
    expect(result.redirect_url).toContain('checkout.stripe.com');
  });
});
