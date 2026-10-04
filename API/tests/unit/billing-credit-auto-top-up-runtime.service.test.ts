import { BillingAppKeyPurpose, BillingCreditAutoTopUpAttemptStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { runCreditAutoTopUpAccount } from '../../src/services/billing-credit-auto-top-up-runtime.service.js';

describe('automatic credit top-up dispatch', () => {
  it('dispatches a pending attempt once with its original consent after the saved card changes', async () => {
    const account = { id: 'account_1', stripeAccountId: 'acct_1', livemode: false };
    const attempt = {
      id: 'attempt_1',
      accountId: account.id,
      creditAccountId: 'credit_1',
      catalogId: 'catalog_1',
      serviceId: 'service_1',
      appKeyId: 'app_key_1',
      attributedUserId: 'user_1',
      optionId: 'option_1',
      offerId: 'offer_1',
      consentRevisionId: 'consent_old',
      consentVersion: 'credits-v1',
      thresholdMicrocredits: 200_000_000n,
      monthlyChargeCapMinor: 1_500n,
      chargedThisMonthBeforeMinor: 0n,
      observedBalanceMicrocredits: 100_000_000n,
      paymentAmountMinor: 500n,
      creditsReceivedMicrocredits: 5_000_000_000n,
      billingMonth: '2026-10',
      idempotencyKey: 'uoa:auto-top-up:attempt_1',
      stripePaymentIntentId: null,
      status: BillingCreditAutoTopUpAttemptStatus.PENDING,
      consentRevision: {
        serviceId: 'service_1',
        appKeyId: 'app_key_1',
        policyId: 'policy_1',
        optionId: 'option_1',
        refillOfferId: 'offer_1',
        consentedByUserId: 'user_1',
        consentVersion: 'credits-v1',
        thresholdMicrocredits: 200_000_000n,
        monthlyChargeCapMinor: 1_500n,
        refillPaymentAmountMinor: 500n,
        refillCreditsMicrocredits: 5_000_000_000n,
        stripePaymentMethodId: 'pm_old',
      },
      creditAccount: {
        id: 'credit_1',
        accountId: account.id,
        orgId: 'org_1',
        teamId: 'team_1',
        stripePaymentMethodId: 'pm_new',
        customer: {
          accountId: account.id,
          orgId: 'org_1',
          teamId: 'team_1',
          scope: 'TEAM',
          scopeKey: 'org_1:team_1',
          stripeCustomerId: 'cus_1',
        },
      },
      catalog: {
        accountId: account.id,
        currency: 'USD',
        paymentAmountMinor: 500n,
        creditsReceivedMicrocredits: 5_000_000_000n,
        key: 'credits-5k',
        version: 1,
      },
      appKey: {
        id: 'app_key_1',
        serviceId: 'service_1',
        purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
      },
      option: {
        id: 'option_1',
        policyId: 'policy_1',
        serviceId: 'service_1',
        refillOfferId: 'offer_1',
      },
      offer: {
        id: 'offer_1',
        policyId: 'policy_1',
        serviceId: 'service_1',
        catalogKey: 'credits-5k',
        catalogVersion: 1,
        paymentAmountMinor: 500n,
        creditsReceivedMicrocredits: 5_000_000_000n,
      },
    };
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: attempt.id }]),
      billingCreditAutoTopUpAttempt: {
        findUnique: vi.fn().mockResolvedValue(attempt),
        update: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (run: (tx: typeof transaction) => Promise<unknown>) => run(transaction)),
    };
    const create = vi.fn().mockResolvedValue({
      id: 'pi_attempt_1',
      object: 'payment_intent',
      amount: 500,
      currency: 'usd',
      customer: 'cus_1',
      payment_method: 'pm_old',
      metadata: {
        uoa_credit_auto_top_up_attempt_id: attempt.id,
        uoa_service_id: attempt.serviceId,
        uoa_app_key_id: attempt.appKeyId,
        uoa_credit_account_id: attempt.creditAccountId,
      },
      livemode: false,
      status: 'processing',
    });
    const claim = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'dispatch', creditAccountId: 'credit_1', attemptId: attempt.id, created: false })
      .mockResolvedValueOnce({
        kind: 'awaiting_webhook',
        creditAccountId: 'credit_1',
        attemptId: attempt.id,
        stripePaymentIntentId: 'pi_attempt_1',
      });

    const submitted = await runCreditAutoTopUpAccount(
      { account, creditAccountId: 'credit_1' },
      { prisma: prisma as never, stripe: { paymentIntents: { create } } as never, claim: claim as never },
    );
    const replay = await runCreditAutoTopUpAccount(
      { account, creditAccountId: 'credit_1' },
      { prisma: prisma as never, stripe: { paymentIntents: { create } } as never, claim: claim as never },
    );

    expect(submitted).toMatchObject({ outcome: 'submitted', attemptId: attempt.id });
    expect(replay).toMatchObject({ outcome: 'awaiting_webhook', attemptId: attempt.id });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      customer: 'cus_1',
      payment_method: 'pm_old',
    });
    expect(create.mock.calls[0]?.[1]).toEqual({ idempotencyKey: attempt.idempotencyKey });
  });
});
