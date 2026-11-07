import { Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { expect, it, vi } from 'vitest';
import { claimCreditAutoTopUpAttempt, listCreditAutoTopUpCandidateIds, listCreditAutoTopUpWebhookCandidates } from '../../src/services/billing-credit-auto-top-up-attempt.service.js';
import { runCreditAutoTopUpCycle } from '../../src/services/billing-credit-auto-top-up-runtime.service.js';

import { applyTrustedCreditFundingStripeEvent } from '../../src/services/billing-stripe-webhook-event.service.js';

import { ids, stripeAccount, embeddedError, pendingDisabled, disableCreditAccountWithAuditEvidence, handle } from './billing-credit-auto-top-up-runtime.suite-fixture.js';

export function registerCases2() {
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
      'TEAM',
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
      teamId: pendingDisabled.team,
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

  it('requires current manager authority and allows an audited disable with a rotated key', async () => {
    const attempt = await handle!.prisma.billingCreditAutoTopUpAttempt.findFirstOrThrow({
      where: { creditAccountId: embeddedError.creditAccount },
    });
    expect(attempt.stripePaymentIntentId).toBe('pi_auto_top_up_embedded');

    await expect(
      handle!.prisma.billingCreditAccount.update({
        where: { id: embeddedError.creditAccount },
        data: { autoTopUpThresholdMicrocredits: 150_000_000n },
      }),
    ).rejects.toBeDefined();

    await expect(
      disableCreditAccountWithAuditEvidence(
        handle!.prisma,
        embeddedError.creditAccount,
        'actor_auto_top_up_non_manager_disable',
        embeddedError.team,
        'TEAM',
        undefined,
        ids.nonManagerUser,
      ),
    ).rejects.toBeDefined();
    await expect(
      handle!.prisma.billingCreditAccount.findUniqueOrThrow({
        where: { id: embeddedError.creditAccount },
      }),
    ).resolves.toMatchObject({ autoTopUpState: 'ACTIVE' });

    await disableCreditAccountWithAuditEvidence(
      handle!.prisma,
      embeddedError.creditAccount,
      'actor_auto_top_up_embedded_disable',
      embeddedError.team,
      'TEAM',
      { serviceId: ids.service, appKeyId: ids.rotatedAppKey, product: 'auto-top-up-test' },
    );

    const [creditAccount, savedAttempt, disableEvent] = await Promise.all([
      handle!.prisma.billingCreditAccount.findUniqueOrThrow({
        where: { id: embeddedError.creditAccount },
      }),
      handle!.prisma.billingCreditAutoTopUpAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      handle!.prisma.billingCreditAutoTopUpDisableEvent.findUniqueOrThrow({
        where: {
          appKeyId_actorJti: {
            appKeyId: ids.rotatedAppKey,
            actorJti: 'actor_auto_top_up_embedded_disable',
          },
        },
      }),
    ]);
    expect(creditAccount.autoTopUpState).toBe('DISABLED');
    expect(disableEvent).toMatchObject({
      serviceId: ids.service,
      appKeyId: ids.rotatedAppKey,
      teamId: embeddedError.team,
      previousConsentRevisionId: attempt.consentRevisionId,
      previousGeneration: 0,
    });
    expect(savedAttempt).toMatchObject({
      consentRevisionId: attempt.consentRevisionId,
      stripePaymentIntentId: 'pi_auto_top_up_embedded',
    });
  }, 20_000);
}
