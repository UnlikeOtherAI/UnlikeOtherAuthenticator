import { BillingAssignmentScope, BillingCreditAutoTopUpConsentSource } from '@prisma/client';

import { expect, it } from 'vitest';

import { ids, concurrency, disableCreditAccountWithAuditEvidence, handle } from './billing-credit-auto-top-up-runtime.suite-fixture.js';

export function registerCases3() {
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
}
