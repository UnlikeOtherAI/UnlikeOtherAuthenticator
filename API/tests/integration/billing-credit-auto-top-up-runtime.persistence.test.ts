import { Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { claimCreditAutoTopUpAttempt, listCreditAutoTopUpCandidateIds, listCreditAutoTopUpWebhookCandidates } from '../../src/services/billing-credit-auto-top-up-attempt.service.js';
import { runCreditAutoTopUpCycle, runCreditAutoTopUpAccount } from '../../src/services/billing-credit-auto-top-up-runtime.service.js';
import { applyTrustedCreditFundingStripeEvent } from '../../src/services/billing-stripe-webhook-event.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { ids, stripeAccount, scopedIds, concurrency, recovery, embeddedError, aboveThreshold, disabled, pendingDisabled, seedCreditAccount, seed, paymentIntent, disableCreditAccountWithAuditEvidence } from '../helpers/credit-auto-top-up-runtime-fixture.js';
const databaseTestsEnabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

describe.skipIf(!databaseTestsEnabled)('credit automatic top-up PostgreSQL runtime', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    await seed(handle.prisma);
  });

  afterAll(async () => {
    if (handle) await handle.cleanup();
    vi.unstubAllEnvs();
  });

  it('selects only active exact-organisation accounts below their configured threshold', async () => {
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

  it('recovers the original PaymentIntent after a lost create response and credits it once under concurrent scans', async () => {
    const claim = await claimCreditAutoTopUpAttempt(
      { accountId: ids.account, creditAccountId: pendingDisabled.creditAccount },
      { prisma: handle!.prisma },
    );
    expect(claim.kind).toBe('dispatch');
    if (claim.kind !== 'dispatch') throw new Error('Expected a pending attempt');
    const attemptBeforeDisable = await handle!.prisma.billingCreditAutoTopUpAttempt.findUniqueOrThrow({
      where: { id: claim.attemptId },
    });
    const intentId = 'pi_auto_top_up_pending_disabled';
    const candidateIds = await listCreditAutoTopUpCandidateIds(
      { accountId: ids.account, limit: 20 },
      { prisma: handle!.prisma },
    );
    expect(candidateIds).toContain(pendingDisabled.creditAccount);
    const webhookCandidates = await listCreditAutoTopUpWebhookCandidates(
      {
        accountId: ids.account,
        creditAccountIds: [pendingDisabled.creditAccount],
        limit: 20,
      },
      { prisma: handle!.prisma },
    );
    expect(webhookCandidates).toMatchObject([
      {
        attemptId: claim.attemptId,
        creditAccountId: pendingDisabled.creditAccount,
        stripePaymentIntentId: null,
      },
    ]);

    // A manager can revoke future consent while the original Stripe request is
    // unresolved. The old attempt remains bound to its original consent and
    // can settle only from the matching payment event.
    await expect(
      handle!.prisma.billingCreditAccount.update({
        where: { id: pendingDisabled.creditAccount },
        data: { stripePaymentMethodId: 'pm_unapproved_change' },
      }),
    ).rejects.toBeDefined();
    await expect(
      handle!.prisma.billingCreditAccount.update({
        where: { id: pendingDisabled.creditAccount },
        data: {
          autoTopUpGeneration: { increment: 1 },
          autoTopUpState: 'DISABLED',
          autoTopUpPolicyId: null,
          autoTopUpServiceId: null,
          autoTopUpAppKeyId: null,
          autoTopUpConsentRevisionId: null,
          autoTopUpOptionId: null,
          autoTopUpThresholdMicrocredits: null,
          autoTopUpRefillOfferId: null,
          autoTopUpMonthlyChargeCapMinor: null,
          autoTopUpConsentVersion: null,
          autoTopUpConsentedAt: null,
          autoTopUpConsentedByUserId: null,
          stripePaymentMethodId: null,
          paymentMethodSummary: Prisma.DbNull,
        },
      }),
    ).rejects.toBeDefined();
    const disableActorJti = 'actor_auto_top_up_pending_disabled';
    await disableCreditAccountWithAuditEvidence(
      handle!.prisma,
      pendingDisabled.creditAccount,
      disableActorJti,
      pendingDisabled.team,
      'ORGANISATION',
      {
        serviceId: ids.otherService,
        appKeyId: ids.otherAppKey,
        product: 'auto-top-up-other-test',
      },
    );
    const disableEvent = await handle!.prisma.billingCreditAutoTopUpDisableEvent.findUniqueOrThrow({
      where: { appKeyId_actorJti: { appKeyId: ids.otherAppKey, actorJti: disableActorJti } },
    });
    expect(disableEvent).toMatchObject({
      serviceId: ids.otherService,
      appKeyId: ids.otherAppKey,
      teamId: null,
      previousConsentRevisionId: attemptBeforeDisable.consentRevisionId,
      previousGeneration: 0,
    });

    const now = new Date();
    const metadata = {
      uoa_credit_auto_top_up_attempt_id: claim.attemptId,
      uoa_service_id: ids.service,
      uoa_app_key_id: ids.appKey,
      uoa_credit_account_id: pendingDisabled.creditAccount,
    };
    const paidIntent = {
      id: intentId,
      object: 'payment_intent',
      amount: 500,
      amount_received: 500,
      currency: 'usd',
      customer: `cus_auto_top_up_pending-disabled`,
      payment_method: `pm_auto_top_up_pending-disabled`,
      latest_charge: 'ch_auto_top_up_pending_disabled',
      livemode: false,
      status: 'succeeded',
      metadata,
    } as Stripe.PaymentIntent;
    const successEvent = {
      id: 'evt_auto_top_up_pending_disabled_success',
      type: 'payment_intent.succeeded',
      api_version: '2026-06-24.dahlia',
      account: stripeAccount.stripeAccountId,
      livemode: false,
      created: Math.floor(now.getTime() / 1000),
      data: { object: paidIntent },
    } as Stripe.Event;
    const failedEvent = {
      ...successEvent,
      id: 'evt_auto_top_up_pending_disabled_failure',
      type: 'payment_intent.payment_failed',
      created: Math.floor(now.getTime() / 1000) - 1,
      data: {
        object: {
          ...paidIntent,
          status: 'requires_payment_method',
          last_payment_error: { code: 'card_declined' },
        },
      },
    } as Stripe.Event;
    const stripe = {
      accounts: {
        retrieveCurrent: vi.fn().mockResolvedValue({ id: stripeAccount.stripeAccountId }),
      },
      events: {
        list: vi.fn().mockResolvedValue({ data: [successEvent, failedEvent], has_more: false }),
      },
      paymentIntents: {
        create: vi.fn(),
        retrieve: vi.fn().mockResolvedValue(paidIntent),
      },
      checkout: { sessions: { retrieve: vi.fn(), list: vi.fn() } },
      paymentMethods: { retrieve: vi.fn() },
      prices: { retrieve: vi.fn() },
      products: { retrieve: vi.fn() },
      disputes: { retrieve: vi.fn() },
      refunds: { retrieve: vi.fn() },
      setupIntents: { retrieve: vi.fn() },
    } as never;
    const runCycle = () =>
      runCreditAutoTopUpCycle({
        prisma: handle!.prisma,
        stripe,
        stripeLivemode: false,
        listCandidates: vi.fn().mockResolvedValue([pendingDisabled.creditAccount]),
        now: () => now,
    });
    const [first, second] = await Promise.all([runCycle(), runCycle()]);
    const attempt = await handle!.prisma.billingCreditAutoTopUpAttempt.findUniqueOrThrow({
      where: { id: claim.attemptId },
    });
    const entries = await handle!.prisma.billingCreditEntry.findMany({
      where: {
        sourceType: 'credit_auto_top_up_attempt',
        sourceId: claim.attemptId,
      },
    });
    const creditAccount = await handle!.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: pendingDisabled.creditAccount },
    });

    expect(attempt.status).toBe('SUCCEEDED');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amountMicrocredits).toBe(5_000_000_000n);
    expect(creditAccount.balanceMicrocredits).toBe(5_100_000_000n);
    expect(creditAccount.autoTopUpState).toBe('DISABLED');
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(stripe.events.list).toHaveBeenCalledTimes(2);
    expect([first, second].map((result) => result.recovered).sort()).toEqual([0, 1]);

    const replay = await applyTrustedCreditFundingStripeEvent({
      event: successEvent,
      expectedPaymentIntentId: intentId,
      stripe,
      account: stripeAccount,
      prisma: handle!.prisma,
    });
    expect(replay).toEqual({ duplicate: true, applied: false });
    await expect(
      handle!.prisma.billingCreditEntry.count({
        where: {
          sourceType: 'credit_auto_top_up_attempt',
          sourceId: claim.attemptId,
        },
      }),
    ).resolves.toBe(1);
  }, 20_000);

});
