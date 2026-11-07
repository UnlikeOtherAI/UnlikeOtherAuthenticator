import { BillingAssignmentScope, BillingCreditAutoTopUpConsentSource } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCreditAutoTopUpAccount } from '../../src/services/billing-credit-auto-top-up-runtime.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { ids, stripeAccount, concurrency, embeddedError, seed, paymentIntent, disableCreditAccountWithAuditEvidence } from '../helpers/credit-auto-top-up-runtime-fixture.js';
const databaseTestsEnabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

describe.skipIf(!databaseTestsEnabled)('credit automatic top-up PostgreSQL disable authority', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    await seed(handle.prisma);
    await runCreditAutoTopUpAccount({ account: stripeAccount, creditAccountId: embeddedError.creditAccount }, { prisma: handle.prisma, stripe: { paymentIntents: { create: async () => { const attempt = await handle!.prisma.billingCreditAutoTopUpAttempt.findFirstOrThrow({ where: { creditAccountId: embeddedError.creditAccount } }); return paymentIntent(attempt.id, 'embedded'); } } } as never });
  });

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

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

  it('matches the audited disable to a NULL team for organization-scoped credits', async () => {
    const customerId = 'bsc_auto_top_up_organization';
    const creditAccountId = 'bca_auto_top_up_organization';
    const revisionId = 'bcar_auto_top_up_organization';
    const attemptId = 'bcattempt_auto_top_up_organization';
    const paymentMethodSummary = { type: 'card', brand: 'visa', last4: '4242' };
    const consentedAt = new Date('2026-07-21T12:00:00.000Z');

    await handle!.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.billingStripeCustomer.create({
        data: {
          id: customerId,
          accountId: ids.account,
          orgId: ids.org,
          scope: BillingAssignmentScope.ORGANISATION,
          scopeKey: ids.org,
          stripeCustomerId: 'cus_auto_top_up_organization',
        },
      });
      await tx.billingCreditAccount.create({
        data: {
          id: creditAccountId,
          accountId: ids.account,
          customerId,
          orgId: ids.org,
          teamId: null,
          scope: BillingAssignmentScope.ORGANISATION,
          scopeKey: ids.org,
        },
      });
      await tx.billingCreditAutoTopUpConsentRevision.create({
        data: {
          id: revisionId,
          accountId: ids.account,
          creditAccountId,
          orgId: ids.org,
          teamId: null,
          serviceId: ids.service,
          appKeyId: ids.appKey,
          policyId: ids.policy,
          optionId: ids.option,
          refillOfferId: ids.offer,
          source: BillingCreditAutoTopUpConsentSource.CUSTOMER_UPDATE,
          actorJti: 'actor_auto_top_up_organization_setup',
          consentedByUserId: ids.user,
          consentVersion: 'auto-top-up-v1',
          thresholdMicrocredits: 200_000_000n,
          refillCreditsMicrocredits: 5_000_000_000n,
          refillPaymentAmountMinor: 500n,
          monthlyChargeCapMinor: 1_500n,
          stripePaymentMethodId: 'pm_auto_top_up_organization',
          paymentMethodSummary,
          consentedAt,
        },
      });
      await tx.billingCreditAccount.update({
        where: { id: creditAccountId },
        data: {
          autoTopUpGeneration: 1,
          autoTopUpState: 'ACTIVE',
          autoTopUpPolicyId: ids.policy,
          autoTopUpServiceId: ids.service,
          autoTopUpAppKeyId: ids.appKey,
          autoTopUpConsentRevisionId: revisionId,
          autoTopUpOptionId: ids.option,
          autoTopUpThresholdMicrocredits: 200_000_000n,
          autoTopUpRefillOfferId: ids.offer,
          autoTopUpMonthlyChargeCapMinor: 1_500n,
          autoTopUpConsentVersion: 'auto-top-up-v1',
          autoTopUpConsentedAt: consentedAt,
          autoTopUpConsentedByUserId: ids.user,
          stripePaymentMethodId: 'pm_auto_top_up_organization',
          paymentMethodSummary,
        },
      });
      await tx.billingCreditAutoTopUpAttempt.create({
        data: {
          id: attemptId,
          accountId: ids.account,
          creditAccountId,
          catalogId: ids.catalog,
          serviceId: ids.service,
          appKeyId: ids.appKey,
          attributedUserId: ids.user,
          optionId: ids.option,
          offerId: ids.offer,
          consentRevisionId: revisionId,
          consentVersion: 'auto-top-up-v1',
          thresholdMicrocredits: 200_000_000n,
          monthlyChargeCapMinor: 1_500n,
          chargedThisMonthBeforeMinor: 0n,
          observedBalanceMicrocredits: 0n,
          paymentAmountMinor: 500n,
          creditsReceivedMicrocredits: 5_000_000_000n,
          billingMonth: '2026-10',
          idempotencyKey: `uoa:auto-top-up:${attemptId}`,
        },
      });
    });

    await expect(
      handle!.prisma.$transaction(async (tx) => {
        await tx.billingCreditAutoTopUpDisableEvent.create({
          data: {
            accountId: ids.account,
            creditAccountId,
            orgId: ids.org,
            teamId: concurrency.team,
            serviceId: ids.service,
            appKeyId: ids.appKey,
            previousConsentRevisionId: revisionId,
            previousGeneration: 1,
            actorJti: 'actor_auto_top_up_wrong_team',
            requestedByUserId: ids.user,
          },
        });
      }),
    ).rejects.toBeDefined();

    await disableCreditAccountWithAuditEvidence(
      handle!.prisma,
      creditAccountId,
      'actor_auto_top_up_organization_disable',
      concurrency.team,
      'ORGANISATION',
    );
    const [creditAccount, attempt] = await Promise.all([
      handle!.prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: creditAccountId } }),
      handle!.prisma.billingCreditAutoTopUpAttempt.findUniqueOrThrow({ where: { id: attemptId } }),
    ]);
    expect(creditAccount).toMatchObject({
      teamId: null,
      autoTopUpGeneration: 2,
      autoTopUpState: 'DISABLED',
    });
    expect(attempt).toMatchObject({ status: 'PENDING', consentRevisionId: revisionId });
  }, 20_000);
});
