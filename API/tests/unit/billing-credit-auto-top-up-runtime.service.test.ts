import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attemptCanStartPaymentIntent,
  runCreditAutoTopUpCycle,
} from '../../src/services/billing-credit-auto-top-up-runtime.service.js';
import { startCreditAutoTopUpScheduler } from '../../src/services/billing-credit-auto-top-up-scheduler.service.js';

const account = {
  id: 'stripe_account_row',
  stripeAccountId: 'acct_auto_top_up',
  livemode: false,
};

describe('credit automatic top-up runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a new intent only while the original consent remains active and current', () => {
    const attempt = {
      consentRevisionId: 'consent_original',
      creditAccount: {
        autoTopUpState: 'ACTIVE',
        autoTopUpConsentRevisionId: 'consent_original',
      },
    };

    expect(attemptCanStartPaymentIntent(attempt as never)).toBe(true);
    expect(
      attemptCanStartPaymentIntent({
        ...attempt,
        creditAccount: { ...attempt.creditAccount, autoTopUpState: 'DISABLED' },
      } as never),
    ).toBe(false);
    expect(
      attemptCanStartPaymentIntent({
        ...attempt,
        creditAccount: { ...attempt.creditAccount, autoTopUpConsentRevisionId: 'consent_new' },
      } as never),
    ).toBe(false);
  });

  it('processes only the exact Stripe account candidates and isolates account failures', async () => {
    const prisma = {
      billingStripeAccount: { upsert: vi.fn().mockResolvedValue(account) },
    };
    const stripe = {
      accounts: { retrieveCurrent: vi.fn().mockResolvedValue({ id: account.stripeAccountId }) },
      paymentIntents: { create: vi.fn() },
    };
    const listCandidates = vi.fn().mockResolvedValue(['credit_a', 'credit_b', 'credit_c']);
    const listWebhookCandidates = vi.fn().mockResolvedValue([]);
    const runAccount = vi
      .fn()
      .mockResolvedValueOnce({
        creditAccountId: 'credit_a',
        outcome: 'submitted',
        attemptId: 'attempt_a',
        stripePaymentIntentId: 'pi_a',
        stripeStatus: 'processing',
      })
      .mockResolvedValueOnce({
        creditAccountId: 'credit_b',
        outcome: 'skipped',
        reason: 'monthly_cap_reached',
      })
      .mockResolvedValueOnce({
        creditAccountId: 'credit_c',
        outcome: 'failed',
        attemptId: 'attempt_c',
        error: 'STRIPE_CONNECTION_ERROR',
      });

    const result = await runCreditAutoTopUpCycle({
      prisma: prisma as never,
      stripe: stripe as never,
      stripeLivemode: false,
      listCandidates,
      listWebhookCandidates,
      runAccount: runAccount as never,
      batchSize: 25,
    });

    expect(listCandidates).toHaveBeenCalledWith({ accountId: account.id, limit: 25 }, { prisma });
    expect(listWebhookCandidates).toHaveBeenCalledWith(
      {
        accountId: account.id,
        creditAccountIds: ['credit_a', 'credit_b', 'credit_c'],
        limit: 25,
      },
      { prisma },
    );
    expect(runAccount).toHaveBeenCalledTimes(3);
    expect(runAccount).toHaveBeenNthCalledWith(
      1,
      { account, creditAccountId: 'credit_a' },
      { prisma, stripe },
    );
    expect(result).toMatchObject({
      accountId: account.id,
      attempted: 3,
      submitted: 1,
      awaitingWebhook: 0,
      recovered: 0,
      terminal: 0,
      skipped: 1,
      failed: 1,
    });
  });

  it('recovers known payment events in one account batch without dispatching another intent', async () => {
    const prisma = {
      billingStripeAccount: { upsert: vi.fn().mockResolvedValue(account) },
    };
    const stripe = {
      accounts: { retrieveCurrent: vi.fn().mockResolvedValue({ id: account.stripeAccountId }) },
      events: { list: vi.fn() },
      paymentIntents: { create: vi.fn() },
    };
    const candidates = [
      {
        attemptId: 'attempt_paid',
        creditAccountId: 'credit_paid',
        stripePaymentIntentId: 'pi_paid',
        createdAt: new Date('2026-10-03T10:00:00.000Z'),
      },
      {
        attemptId: 'attempt_missing',
        creditAccountId: 'credit_missing',
        stripePaymentIntentId: 'pi_missing',
        createdAt: new Date('2026-10-03T11:00:00.000Z'),
      },
    ];
    const runAccount = vi.fn();
    const recoverEvents = vi.fn().mockResolvedValue({
      recoveredPaymentIntentIds: new Set(['pi_paid']),
      recoveredAttemptPaymentIntents: new Map([['attempt_paid', 'pi_paid']]),
      diagnostics: new Map([['attempt_missing', 'event_not_found']]),
    });

    const result = await runCreditAutoTopUpCycle({
      prisma: prisma as never,
      stripe: stripe as never,
      stripeLivemode: false,
      listCandidates: vi.fn().mockResolvedValue(['credit_paid', 'credit_missing']),
      listWebhookCandidates: vi.fn().mockResolvedValue(candidates),
      recoverEvents,
      runAccount: runAccount as never,
      now: () => new Date('2026-10-04T10:00:00.000Z'),
    });

    expect(recoverEvents).toHaveBeenCalledOnce();
    expect(recoverEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        candidates,
        now: new Date('2026-10-04T10:00:00.000Z'),
        prisma,
        stripe,
      }),
    );
    expect(runAccount).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      attempted: 2,
      recovered: 1,
      awaitingWebhook: 1,
      failed: 0,
      results: [
        { outcome: 'recovered', attemptId: 'attempt_paid', stripePaymentIntentId: 'pi_paid' },
        {
          outcome: 'awaiting_webhook',
          attemptId: 'attempt_missing',
          recoveryDiagnostic: 'event_not_found',
        },
      ],
    });
  });

  it('does not create a replacement intent while the original attempt has no persisted intent ID', async () => {
    const prisma = {
      billingStripeAccount: { upsert: vi.fn().mockResolvedValue(account) },
    };
    const stripe = {
      accounts: { retrieveCurrent: vi.fn().mockResolvedValue({ id: account.stripeAccountId }) },
      events: { list: vi.fn() },
      paymentIntents: { create: vi.fn() },
    };
    const candidate = {
      attemptId: 'attempt_lost_response',
      creditAccountId: 'credit_lost_response',
      stripePaymentIntentId: null,
      createdAt: new Date('2026-10-03T10:00:00.000Z'),
    };
    const runAccount = vi.fn();
    const result = await runCreditAutoTopUpCycle({
      prisma: prisma as never,
      stripe: stripe as never,
      stripeLivemode: false,
      listCandidates: vi.fn().mockResolvedValue([candidate.creditAccountId]),
      listWebhookCandidates: vi.fn().mockResolvedValue([candidate]),
      recoverEvents: vi.fn().mockResolvedValue({
        recoveredPaymentIntentIds: new Set(),
        recoveredAttemptPaymentIntents: new Map(),
        diagnostics: new Map([[candidate.attemptId, 'event_not_found']]),
      }),
      runAccount: runAccount as never,
    });

    expect(runAccount).not.toHaveBeenCalled();
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(result.results).toMatchObject([
      {
        outcome: 'awaiting_webhook',
        attemptId: candidate.attemptId,
        stripePaymentIntentId: null,
        recoveryDiagnostic: 'event_not_found',
      },
    ]);
  });

  it('fails closed under the Stripe billing kill switch', async () => {
    const previous = process.env.STRIPE_BILLING_ENABLED;
    process.env.STRIPE_BILLING_ENABLED = 'false';
    try {
      await expect(runCreditAutoTopUpCycle()).rejects.toThrow('STRIPE_BILLING_DISABLED');
    } finally {
      if (previous === undefined) delete process.env.STRIPE_BILLING_ENABLED;
      else process.env.STRIPE_BILLING_ENABLED = previous;
    }
  });

  it('never overlaps cycles and requests one immediate recovery pass', async () => {
    vi.useFakeTimers();
    let finishFirst: ((value: never) => void) | undefined;
    const first = new Promise((resolve) => {
      finishFirst = resolve;
    });
    const emptyResult = {
      accountId: account.id,
      attempted: 0,
      submitted: 0,
      awaitingWebhook: 0,
      recovered: 0,
      terminal: 0,
      skipped: 0,
      failed: 0,
      results: [],
    };
    const runCycle = vi.fn().mockReturnValueOnce(first).mockResolvedValue(emptyResult);
    const scheduler = startCreditAutoTopUpScheduler({
      log: { info: vi.fn(), error: vi.fn() },
      runCycle,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(runCycle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runCycle).toHaveBeenCalledTimes(1);
    finishFirst?.(emptyResult as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(runCycle).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('preserves the logger receiver when a cycle reports failures', async () => {
    vi.useFakeTimers();
    const receivers: unknown[] = [];
    const log = {
      info: vi.fn(function (this: unknown) {
        receivers.push(this);
      }),
      error: vi.fn(function (this: unknown) {
        receivers.push(this);
      }),
    };
    const scheduler = startCreditAutoTopUpScheduler({
      log,
      runCycle: vi.fn().mockResolvedValue({
        accountId: account.id,
        attempted: 1,
        submitted: 0,
        awaitingWebhook: 0,
        recovered: 0,
        terminal: 0,
        skipped: 0,
        failed: 1,
        results: [
          {
            creditAccountId: 'credit_failed',
            outcome: 'failed',
            error: 'STRIPE_CONNECTION_ERROR',
          },
        ],
      }),
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(log.error).toHaveBeenCalledOnce();
    expect(log.info).not.toHaveBeenCalled();
    expect(receivers).toEqual([log]);
    scheduler.stop();
  });
});
