import { Prisma } from '@prisma/client';

import { expect, it, vi } from 'vitest';
import { claimCreditAutoTopUpAttempt, listCreditAutoTopUpCandidateIds } from '../../src/services/billing-credit-auto-top-up-attempt.service.js';
import { runCreditAutoTopUpCycle, runCreditAutoTopUpAccount } from '../../src/services/billing-credit-auto-top-up-runtime.service.js';

import { ids, stripeAccount, scopedIds, concurrency, recovery, embeddedError, aboveThreshold, disabled, pendingDisabled, seedCreditAccount, paymentIntent, handle } from './billing-credit-auto-top-up-runtime.suite-fixture.js';

export function registerCases1() {
  it('selects only active exact-team accounts below their configured threshold', async () => {
    const candidates = await listCreditAutoTopUpCandidateIds(
      { accountId: ids.account, limit: 10 },
      { prisma: handle!.prisma },
    );

    expect(candidates).toEqual(
      [
        concurrency.creditAccount,
        recovery.creditAccount,
        embeddedError.creditAccount,
        pendingDisabled.creditAccount,
      ].sort(),
    );
    expect(candidates).not.toContain(aboveThreshold.creditAccount);
    expect(candidates).not.toContain(disabled.creditAccount);
  });

  it('commits one attempt before Stripe and serializes concurrent dispatch per account', async () => {
    const create = vi.fn(async (_params: unknown, options: { idempotencyKey?: string }) => {
      const attempts = await handle!.prisma.billingCreditAutoTopUpAttempt.findMany({
        where: { creditAccountId: concurrency.creditAccount },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0].stripePaymentIntentId).toBeNull();
      expect(options.idempotencyKey).toBe(attempts[0].idempotencyKey);
      return paymentIntent(attempts[0].id, 'concurrency');
    });
    const stripe = { paymentIntents: { create } } as never;

    const results = await Promise.all([
      runCreditAutoTopUpAccount(
        { account: stripeAccount, creditAccountId: concurrency.creditAccount },
        { prisma: handle!.prisma, stripe },
      ),
      runCreditAutoTopUpAccount(
        { account: stripeAccount, creditAccountId: concurrency.creditAccount },
        { prisma: handle!.prisma, stripe },
      ),
    ]);

    const attempts = await handle!.prisma.billingCreditAutoTopUpAttempt.findMany({
      where: { creditAccountId: concurrency.creditAccount },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].stripePaymentIntentId).toBe('pi_auto_top_up_concurrency');
    expect(attempts[0]).toMatchObject({
      serviceId: ids.service,
      appKeyId: ids.appKey,
      attributedUserId: ids.user,
      paymentAmountMinor: 500n,
      creditsReceivedMicrocredits: 5_000_000_000n,
      observedBalanceMicrocredits: 100_000_000n,
      chargedThisMonthBeforeMinor: 0n,
    });
    expect(results.map((result) => result.outcome).sort()).toEqual([
      'awaiting_webhook',
      'submitted',
    ]);
    expect(create).toHaveBeenCalledWith(
      {
        amount: 500,
        currency: 'usd',
        customer: 'cus_auto_top_up_concurrency',
        payment_method: 'pm_auto_top_up_concurrency',
        confirm: true,
        off_session: true,
        metadata: {
          uoa_credit_auto_top_up_attempt_id: attempts[0].id,
          uoa_service_id: ids.service,
          uoa_app_key_id: ids.appKey,
          uoa_credit_account_id: concurrency.creditAccount,
        },
        description: 'Automatic credit top-up',
      },
      { idempotencyKey: attempts[0].idempotencyKey },
    );
  }, 20_000);

  it('recovers an ambiguous Stripe create with the same durable attempt and key', async () => {
    const firstCreate = vi.fn().mockRejectedValue(new Error('socket closed after request write'));
    const first = await runCreditAutoTopUpAccount(
      { account: stripeAccount, creditAccountId: recovery.creditAccount },
      { prisma: handle!.prisma, stripe: { paymentIntents: { create: firstCreate } } as never },
    );
    const pending = await handle!.prisma.billingCreditAutoTopUpAttempt.findMany({
      where: { creditAccountId: recovery.creditAccount },
    });

    expect(first).toMatchObject({ outcome: 'failed', attemptId: pending[0].id });
    expect(pending).toHaveLength(1);
    expect(pending[0].stripePaymentIntentId).toBeNull();
    const recoveredCreate = vi.fn().mockResolvedValue(paymentIntent(pending[0].id, 'recovery'));
    const recovered = await runCreditAutoTopUpAccount(
      { account: stripeAccount, creditAccountId: recovery.creditAccount },
      { prisma: handle!.prisma, stripe: { paymentIntents: { create: recoveredCreate } } as never },
    );
    const attempts = await handle!.prisma.billingCreditAutoTopUpAttempt.findMany({
      where: { creditAccountId: recovery.creditAccount },
    });

    expect(attempts).toHaveLength(1);
    expect(attempts[0].id).toBe(pending[0].id);
    expect(attempts[0].stripePaymentIntentId).toBe('pi_auto_top_up_recovery');
    expect(recovered).toMatchObject({
      outcome: 'submitted',
      attemptId: pending[0].id,
      recoveredAttempt: true,
    });
    expect(firstCreate.mock.calls[0]?.[1]).toEqual({ idempotencyKey: pending[0].idempotencyKey });
    expect(recoveredCreate.mock.calls[0]?.[1]).toEqual({
      idempotencyKey: pending[0].idempotencyKey,
    });
  }, 20_000);

  it.each(['recent', 'expired', 'scan-failed'])('recovers scheduler interruption safely: %s', async (mode) => {
    const suffix = `scheduler-${mode}`;
    const row = scopedIds(suffix);
    await handle!.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await seedCreditAccount(tx, suffix, 100_000_000n, true);
    });
    // Commit the production claim, then interrupt before any Stripe call.
    const claim = await claimCreditAutoTopUpAttempt(
      { accountId: ids.account, creditAccountId: row.creditAccount }, { prisma: handle!.prisma },
    );
    expect(claim.kind).toBe('dispatch');
    if (claim.kind !== 'dispatch') throw new Error('Expected a committed pending claim');
    if (mode === 'expired') {
      // Seed a historical immutable attempt, then exercise the real reader/dispatch.
      await handle!.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.$executeRaw(Prisma.sql`
          UPDATE billing_credit_auto_top_up_attempts
          SET created_at = clock_timestamp() - INTERVAL '24 hours' WHERE id = ${claim.attemptId}
        `);
      });
    }
    const create = vi.fn().mockResolvedValue(paymentIntent(claim.attemptId, suffix));
    const stripe = {
      accounts: { retrieveCurrent: vi.fn().mockResolvedValue({ id: stripeAccount.stripeAccountId }) },
      events: { list: mode === 'scan-failed'
        ? vi.fn().mockRejectedValue(new Error('event transport unavailable'))
        : vi.fn().mockResolvedValue({ data: [], has_more: false }) },
      paymentIntents: { create },
    } as never;
    const runCycle = () => runCreditAutoTopUpCycle({
      prisma: handle!.prisma, stripe, stripeLivemode: false,
      listCandidates: vi.fn().mockResolvedValue([row.creditAccount]),
    });
    const results = await Promise.all([runCycle(), runCycle()]);
    const attempts = await handle!.prisma.billingCreditAutoTopUpAttempt.findMany({
      where: { creditAccountId: row.creditAccount },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].id).toBe(claim.attemptId);
    if (mode === 'recent') {
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]?.[1]).toEqual({ idempotencyKey: attempts[0].idempotencyKey });
      expect(results.map((r) => r.submitted).sort()).toEqual([0, 1]);
      expect(attempts[0].stripePaymentIntentId).toBe(`pi_auto_top_up_${suffix}`);
    } else {
      expect(create).not.toHaveBeenCalled();
      expect(results.every((r) => r.awaitingWebhook === 1)).toBe(true);
      expect(attempts[0].stripePaymentIntentId).toBeNull();
    }
    expect(await handle!.prisma.billingCreditEntry.count({
      where: { sourceType: 'credit_auto_top_up_attempt', sourceId: claim.attemptId },
    })).toBe(0);
  }, 20_000);

  it('attaches an exact PaymentIntent returned inside an off-session Stripe error', async () => {
    const create = vi.fn(async (_params: unknown, options: { idempotencyKey?: string }) => {
      const attempt = await handle!.prisma.billingCreditAutoTopUpAttempt.findFirstOrThrow({
        where: { creditAccountId: embeddedError.creditAccount },
      });
      expect(options.idempotencyKey).toBe(attempt.idempotencyKey);
      throw Object.assign(new Error('card requires customer action'), {
        payment_intent: paymentIntent(attempt.id, 'embedded'),
      });
    });

    const result = await runCreditAutoTopUpAccount(
      { account: stripeAccount, creditAccountId: embeddedError.creditAccount },
      { prisma: handle!.prisma, stripe: { paymentIntents: { create } } as never },
    );
    const attempt = await handle!.prisma.billingCreditAutoTopUpAttempt.findFirstOrThrow({
      where: { creditAccountId: embeddedError.creditAccount },
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(attempt.stripePaymentIntentId).toBe('pi_auto_top_up_embedded');
    expect(result).toMatchObject({
      outcome: 'submitted',
      attemptId: attempt.id,
      stripePaymentIntentId: 'pi_auto_top_up_embedded',
      stripeStatus: 'processing',
    });
  }, 20_000);
}
