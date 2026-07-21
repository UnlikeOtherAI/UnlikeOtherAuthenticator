import {
  BillingCreditAutoTopUpState,
  BillingCreditCheckoutStatus,
  MembershipStatus,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  disableBillingCreditAutoTopUp,
  updateBillingCreditAutoTopUp,
} from '../../src/services/billing-credit-auto-top-up-consent.service.js';
import { applyCreditFundingWebhook } from '../../src/services/billing-credit-funding-webhook.service.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  credential,
  databaseTestsEnabled,
  fundingActionContext,
  fundingRaceIds as ids,
  fundingRaceRequest as request,
  occurredAt,
  optionSelection,
  seedFundingRace,
  stripeAccount,
} from './billing-credit-funding-actions.persistence.fixture.js';

describe.skipIf(!databaseTestsEnabled)('credit funding PostgreSQL lifecycle races', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    await seedFundingRace(handle.prisma);
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('installs exact app-key/actor/selection replay indexes', async () => {
    const indexes = await handle!.prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'billing_credit_top_up_checkouts_actor_offer_key',
          'billing_credit_setup_checkouts_actor_option_key'
        )
      ORDER BY indexname
    `;

    expect(indexes.map((row) => row.indexname)).toEqual([
      'billing_credit_setup_checkouts_actor_option_key',
      'billing_credit_top_up_checkouts_actor_offer_key',
    ]);
  });

  it('keeps a late SetupIntent from superseding a newer consent generation', async () => {
    const original = await handle!.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.creditAccount },
    });
    await updateBillingCreditAutoTopUp(
      {
        request: { ...request, optionId: ids.option },
        actorToken: 'stale-preauthorized-actor',
        credential: credential as never,
      },
      {
        prisma: handle!.prisma,
        now: () => new Date('2026-07-21T12:01:00.000Z'),
        resolveContext: vi.fn().mockResolvedValue(fundingActionContext(original)),
        resolveOption: vi.fn().mockResolvedValue(optionSelection),
        validateCatalog: vi.fn(),
      },
    );
    const afterUpdate = await handle!.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.creditAccount },
    });

    await handle!.prisma.$transaction((tx) =>
      applyCreditFundingWebhook(
        tx,
        {
          event: {
            kind: 'setup_succeeded',
            localId: ids.setup,
            setupIntent: { id: 'seti_funding_race', customer: 'cus_funding_race' } as never,
            checkoutSessionId: 'cs_funding_race',
            paymentMethodId: 'pm_stale_setup',
            paymentMethodSummary: { type: 'card', brand: 'visa', last4: '1881' },
            occurredAt,
          },
          eventFields: { stripeCreatedAt: occurredAt },
        },
        ids.webhook,
        stripeAccount,
      ),
    );

    const [account, setup, setupConsents] = await Promise.all([
      handle!.prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: ids.creditAccount } }),
      handle!.prisma.billingCreditSetupCheckout.findUniqueOrThrow({ where: { id: ids.setup } }),
      handle!.prisma.billingCreditAutoTopUpConsentRevision.count({
        where: { setupCheckoutId: ids.setup },
      }),
    ]);
    expect(afterUpdate.autoTopUpGeneration).toBe(1);
    expect(account.autoTopUpConsentRevisionId).toBe(afterUpdate.autoTopUpConsentRevisionId);
    expect(account.stripePaymentMethodId).toBe('pm_funding_race');
    expect(setup.status).toBe(BillingCreditCheckoutStatus.ABANDONED);
    expect(setupConsents).toBe(0);

    await expect(
      handle!.prisma.billingCreditSetupCheckout.create({
        data: {
          id: 'bcsc_funding_race_stale_insert',
          accountId: ids.account,
          creditAccountId: ids.creditAccount,
          customerId: ids.customer,
          serviceId: ids.service,
          appKeyId: ids.appKey,
          policyId: ids.policy,
          optionId: ids.option,
          actorJti: 'actor-stale-insert',
          requestedByUserId: ids.user,
          expectedGeneration: 0,
          expectedConsentRevisionId: ids.originalConsent,
          consentVersion: 'auto-v1',
          thresholdMicrocredits: 200_000_000n,
          refillOfferId: ids.offer,
          refillCreditsMicrocredits: 5_000_000_000n,
          refillPaymentAmountMinor: 500n,
          monthlyChargeCapMinor: 1_500n,
          successUrlDigest: 'e'.repeat(64),
          cancelUrlDigest: 'f'.repeat(64),
          leaseExpiresAt: new Date('2026-07-21T12:20:00.000Z'),
        },
      }),
    ).rejects.toBeDefined();
  }, 20_000);

  it('keeps an abandoned Setup Checkout terminal under its still-current predecessor', async () => {
    const account = await handle!.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.creditAccount },
    });
    const setupId = 'bcsc_funding_race_terminal';
    await handle!.prisma.billingCreditSetupCheckout.create({
      data: {
        id: setupId,
        accountId: ids.account,
        creditAccountId: ids.creditAccount,
        customerId: ids.customer,
        serviceId: ids.service,
        appKeyId: ids.appKey,
        policyId: ids.policy,
        optionId: ids.option,
        actorJti: 'actor-terminal-setup',
        requestedByUserId: ids.user,
        expectedGeneration: account.autoTopUpGeneration,
        expectedConsentRevisionId: account.autoTopUpConsentRevisionId,
        consentVersion: 'auto-v1',
        thresholdMicrocredits: 200_000_000n,
        refillOfferId: ids.offer,
        refillCreditsMicrocredits: 5_000_000_000n,
        refillPaymentAmountMinor: 500n,
        monthlyChargeCapMinor: 1_500n,
        successUrlDigest: '1'.repeat(64),
        cancelUrlDigest: '2'.repeat(64),
        leaseExpiresAt: new Date('2026-07-21T12:20:00.000Z'),
      },
    });
    await handle!.prisma.billingCreditSetupCheckout.update({
      where: { id: setupId },
      data: { status: BillingCreditCheckoutStatus.ABANDONED },
    });

    await expect(
      handle!.prisma.billingCreditSetupCheckout.update({
        where: { id: setupId },
        data: {
          status: BillingCreditCheckoutStatus.OPEN,
          stripeCheckoutSessionId: 'cs_terminal_reopen',
        },
      }),
    ).rejects.toBeDefined();
    await expect(
      handle!.prisma.billingCreditSetupCheckout.findUniqueOrThrow({ where: { id: setupId } }),
    ).resolves.toMatchObject({ status: BillingCreditCheckoutStatus.ABANDONED });
  }, 20_000);

  it('rejects disable when manager authority is revoked after authorization', async () => {
    const preauthorized = await handle!.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.creditAccount },
    });
    await handle!.prisma.teamMember.update({
      where: { id: ids.teamMember },
      data: { status: MembershipStatus.DEACTIVATED },
    });

    await expect(
      disableBillingCreditAutoTopUp(
        {
          request,
          actorToken: 'stale-preauthorized-actor',
          credential: credential as never,
        },
        {
          prisma: handle!.prisma,
          resolveContext: vi.fn().mockResolvedValue(fundingActionContext(preauthorized)),
        },
      ),
    ).rejects.toBeDefined();

    const [account, disableEvents] = await Promise.all([
      handle!.prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: ids.creditAccount } }),
      handle!.prisma.billingCreditAutoTopUpDisableEvent.count({
        where: { creditAccountId: ids.creditAccount },
      }),
    ]);
    expect(account.autoTopUpState).toBe(BillingCreditAutoTopUpState.ACTIVE);
    expect(disableEvents).toBe(0);
    await handle!.prisma.teamMember.update({
      where: { id: ids.teamMember },
      data: { status: MembershipStatus.ACTIVE },
    });
  }, 20_000);

  it('waits for an in-flight manager revocation and then rejects disable', async () => {
    const preauthorized = await handle!.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.creditAccount },
    });
    let releaseRevocation = () => undefined;
    let signalRevocationLocked = () => undefined;
    const revocationGate = new Promise<void>((resolve) => {
      releaseRevocation = resolve;
    });
    const revocationLocked = new Promise<void>((resolve) => {
      signalRevocationLocked = resolve;
    });
    const revocation = handle!.prisma.$transaction(async (tx) => {
      await tx.teamMember.update({
        where: { id: ids.teamMember },
        data: { status: MembershipStatus.DEACTIVATED },
      });
      signalRevocationLocked();
      await revocationGate;
    });
    await revocationLocked;

    let settled = false;
    const disableResult = disableBillingCreditAutoTopUp(
      { request, actorToken: 'concurrent-stale-actor', credential: credential as never },
      {
        prisma: handle!.prisma,
        resolveContext: vi.fn().mockResolvedValue(fundingActionContext(preauthorized)),
      },
    ).then(
      () => {
        settled = true;
        return { ok: true as const };
      },
      (error: unknown) => {
        settled = true;
        return { ok: false as const, error };
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    const waitedForRevocation = !settled;
    releaseRevocation();
    await revocation;
    const result = await disableResult;

    expect(waitedForRevocation).toBe(true);
    expect(result.ok).toBe(false);
    await expect(
      handle!.prisma.billingCreditAccount.findUniqueOrThrow({
        where: { id: ids.creditAccount },
      }),
    ).resolves.toMatchObject({ autoTopUpState: BillingCreditAutoTopUpState.ACTIVE });
    await handle!.prisma.teamMember.update({
      where: { id: ids.teamMember },
      data: { status: MembershipStatus.ACTIVE },
    });
  }, 20_000);
});
