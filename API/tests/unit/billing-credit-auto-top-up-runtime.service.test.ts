import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  runCreditAutoTopUpCycle,
  startCreditAutoTopUpScheduler,
} from '../../src/services/billing-credit-auto-top-up-runtime.service.js';

const account = {
  id: 'stripe_account_row',
  stripeAccountId: 'acct_auto_top_up',
  livemode: false,
};

describe('credit automatic top-up runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
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
      runAccount: runAccount as never,
      batchSize: 25,
    });

    expect(listCandidates).toHaveBeenCalledWith({ accountId: account.id, limit: 25 }, { prisma });
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
      terminal: 0,
      skipped: 1,
      failed: 1,
    });
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
