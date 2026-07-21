import {
  BillingAssignmentScope,
  BillingCollectionMode,
  BillingOrganisationContractStatus,
  BillingTariffMode,
  BillingTariffSource,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

describe.skipIf(!process.env.DATABASE_URL)('contract and Stripe database exclusivity', () => {
  let db: TestDb;

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('blocks manual activation during completed-Checkout reconciliation in both directions', async () => {
    const owner = await db.prisma.user.create({
      data: {
        email: 'contract-stripe-owner@example.com',
        userKey: 'contract-stripe-owner@example.com',
      },
    });
    const org = await db.prisma.organisation.create({
      data: {
        domain: 'contract-stripe.example',
        name: 'Contract Stripe Race',
        slug: 'contract-stripe-race',
        ownerId: owner.id,
      },
    });
    const service = await db.prisma.billingService.create({
      data: { identifier: 'contract-stripe-service', name: 'Contract Stripe Service' },
    });
    const stripeTariff = await db.prisma.billingTariff.create({
      data: {
        serviceId: service.id,
        key: 'stripe-before-contract',
        version: 1,
        name: 'Stripe before contract',
        mode: BillingTariffMode.STANDARD,
        collectionMode: BillingCollectionMode.STRIPE,
        markupBps: 2000,
        monthlyAmountMinor: 1000n,
        currency: 'USD',
        isDefault: false,
      },
    });
    const assignment = await db.prisma.billingTariffAssignment.create({
      data: {
        serviceId: service.id,
        tariffId: stripeTariff.id,
        orgId: org.id,
        teamId: null,
        scope: BillingAssignmentScope.ORGANISATION,
        scopeKey: org.id,
      },
    });
    const appKey = await db.prisma.billingAppKey.create({
      data: {
        serviceId: service.id,
        name: 'Contract race app key',
        keyPrefix: 'uoa_app_contract',
        secretDigest: 'contract-stripe-race-secret-digest',
        actorIssuer: 'https://contract-stripe.example',
        actorAudience: 'https://authentication.unlikeotherai.com',
        actorKeyId: 'contract-race-key',
        actorPublicJwk: { kty: 'RSA', kid: 'contract-race-key', n: 'AQAB', e: 'AQAB' },
      },
    });
    const account = await db.prisma.billingStripeAccount.create({
      data: { stripeAccountId: 'acct_contract_stripe_race', livemode: false },
    });
    const customer = await db.prisma.billingStripeCustomer.create({
      data: {
        accountId: account.id,
        orgId: org.id,
        teamId: null,
        scope: BillingAssignmentScope.ORGANISATION,
        scopeKey: org.id,
        stripeCustomerId: 'cus_contract_stripe_race',
      },
    });
    const checkout = await db.prisma.billingStripeCheckoutSession.create({
      data: {
        accountId: account.id,
        appKeyId: appKey.id,
        customerId: customer.id,
        serviceId: service.id,
        tariffId: stripeTariff.id,
        tariffSource: BillingTariffSource.ORGANISATION,
        tariffAssignmentId: assignment.id,
        orgId: org.id,
        teamId: null,
        scope: BillingAssignmentScope.ORGANISATION,
        scopeKey: org.id,
        actorJti: 'contract-stripe-race-jti',
        requestedByUserId: owner.id,
        successUrlDigest: 'a'.repeat(64),
        cancelUrlDigest: 'b'.repeat(64),
        stripeCheckoutSessionId: 'cs_contract_stripe_race',
        status: 'complete',
        leaseExpiresAt: new Date('2026-07-21T12:10:00.000Z'),
        expiresAt: new Date('2026-07-21T12:30:00.000Z'),
        completedAt: new Date('2026-07-21T12:00:00.000Z'),
      },
    });
    const contract = await db.prisma.billingOrganisationContract.create({
      data: { orgId: org.id, reference: 'stripe-race', name: 'Stripe Race Contract' },
    });
    const version = await db.prisma.billingOrganisationContractVersion.create({
      data: {
        contractId: contract.id,
        version: 1,
        usageMarkupBps: 2000,
        currency: 'USD',
        paymentTermsDays: 30,
        effectiveFromMonth: '2026-07',
      },
    });
    const manualTariff = await db.prisma.billingTariff.create({
      data: {
        serviceId: service.id,
        key: 'manual-contract',
        version: 1,
        name: 'Manual contract',
        mode: BillingTariffMode.CUSTOM,
        collectionMode: BillingCollectionMode.MANUAL,
        markupBps: 2000,
        monthlyAmountMinor: 1000n,
        currency: 'USD',
        isDefault: false,
      },
    });

    await expect(
      db.prisma.$transaction(async (tx) => {
        await tx.billingTariffAssignment.update({
          where: { id: assignment.id },
          data: { tariffId: manualTariff.id },
        });
        await tx.billingContractServiceTerm.create({
          data: {
            contractVersionId: version.id,
            serviceId: service.id,
            tariffId: manualTariff.id,
            tariffAssignmentId: assignment.id,
            monthlyAmountMinor: 1000n,
          },
        });
      }),
    ).rejects.toThrow(/Stripe checkout or subscription blocks manual contract activation/);
    expect(
      await db.prisma.billingTariffAssignment.findUniqueOrThrow({ where: { id: assignment.id } }),
    ).toMatchObject({ tariffId: stripeTariff.id });

    const subscription = await db.prisma.billingStripeSubscription.create({
      data: {
        accountId: account.id,
        checkoutId: checkout.id,
        customerId: customer.id,
        serviceId: service.id,
        tariffId: stripeTariff.id,
        tariffSource: BillingTariffSource.ORGANISATION,
        tariffAssignmentId: assignment.id,
        orgId: org.id,
        teamId: null,
        scope: BillingAssignmentScope.ORGANISATION,
        scopeKey: org.id,
        stripeSubscriptionId: 'sub_contract_stripe_race',
        stripeMonthlyItemId: 'si_contract_monthly',
        stripeUsageItemId: 'si_contract_usage',
        status: 'canceled',
        livemode: false,
      },
    });
    await db.prisma.$transaction(async (tx) => {
      await tx.billingTariffAssignment.update({
        where: { id: assignment.id },
        data: { tariffId: manualTariff.id },
      });
      await tx.billingContractServiceTerm.create({
        data: {
          contractVersionId: version.id,
          serviceId: service.id,
          tariffId: manualTariff.id,
          tariffAssignmentId: assignment.id,
          monthlyAmountMinor: 1000n,
        },
      });
    });
    await db.prisma.billingStripeSubscription.update({
      where: { id: subscription.id },
      data: { status: 'active' },
    });
    await expect(
      db.prisma.billingOrganisationContract.update({
        where: { id: contract.id },
        data: {
          status: BillingOrganisationContractStatus.ACTIVE,
          activatedAt: new Date('2026-07-21T12:00:00.000Z'),
        },
      }),
    ).rejects.toThrow(/Stripe checkout or subscription blocks manual contract activation/);
    await db.prisma.billingStripeSubscription.update({
      where: { id: subscription.id },
      data: { status: 'canceled' },
    });
    await db.prisma.billingOrganisationContract.update({
      where: { id: contract.id },
      data: {
        status: BillingOrganisationContractStatus.ACTIVE,
        activatedAt: new Date('2026-07-21T12:00:00.000Z'),
      },
    });

    await expect(
      db.prisma.billingStripeSubscription.update({
        where: { id: subscription.id },
        data: { status: 'active' },
      }),
    ).rejects.toThrow(/active manual contract blocks Stripe checkout or subscription projection/);
    await expect(
      db.prisma.billingStripeCheckoutSession.create({
        data: {
          accountId: account.id,
          appKeyId: appKey.id,
          customerId: customer.id,
          serviceId: service.id,
          tariffId: manualTariff.id,
          tariffSource: BillingTariffSource.ORGANISATION,
          tariffAssignmentId: assignment.id,
          orgId: org.id,
          teamId: null,
          scope: BillingAssignmentScope.ORGANISATION,
          scopeKey: org.id,
          actorJti: 'contract-after-activation-jti',
          requestedByUserId: owner.id,
          successUrlDigest: 'c'.repeat(64),
          cancelUrlDigest: 'd'.repeat(64),
          status: 'creating',
          leaseExpiresAt: new Date('2026-07-21T13:00:00.000Z'),
        },
      }),
    ).rejects.toThrow(/active manual contract blocks Stripe checkout or subscription projection/);
  }, 120_000);
});
