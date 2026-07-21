import {
  BillingAppKeyPurpose,
  BillingAssignmentScope,
  BillingCollectionMode,
  BillingOrganisationContractStatus,
  BillingRecurringAddonCheckoutStatus,
  BillingRecurringAddonSubscriptionScope,
  BillingTariffMode,
  Prisma,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

describe.skipIf(!process.env.DATABASE_URL)('contract invoice recurring add-on evidence', () => {
  let db: TestDb;

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('snapshots paid Stripe add-ons without adding them to the manual amount due', async () => {
    const owner = await db.prisma.user.create({
      data: {
        email: 'addon-contract-owner@example.com',
        userKey: 'addon-contract-owner@example.com',
      },
    });
    const org = await db.prisma.organisation.create({
      data: {
        domain: 'addon-contract.example',
        name: 'Add-on Contract Test',
        slug: 'addon-contract-test',
        ownerId: owner.id,
      },
    });
    const team = await db.prisma.team.create({
      data: { orgId: org.id, name: 'Add-on Team', slug: 'addon-team' },
    });
    await db.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "org_members" ("id", "org_id", "user_id", "role", "status", "updated_at")
      VALUES ('addon_contract_org_member', ${org.id}, ${owner.id}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP)
    `);
    await db.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "team_members" (
        "id", "team_id", "user_id", "team_role", "status", "updated_at"
      ) VALUES (
        'addon_contract_team_member', ${team.id}, ${owner.id}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP
      )
    `);
    const service = await db.prisma.billingService.create({
      data: { identifier: 'addon-contract-service', name: 'Add-on Contract Service' },
    });
    const appKey = await db.prisma.billingAppKey.create({
      data: {
        serviceId: service.id,
        purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
        name: 'Add-on contract test key',
        keyPrefix: 'uoa_addon_test',
        secretDigest: 'addon-contract-test-secret-digest',
        actorIssuer: 'https://addon-contract.example',
        actorAudience: 'https://authentication.unlikeotherai.com',
        actorKeyId: 'addon-contract-key',
        actorPublicJwk: { kty: 'RSA', n: 'AQAB', e: 'AQAB' },
        checkoutReturnOrigins: ['https://addon-contract.example'],
      },
    });
    const stripeAccount = await db.prisma.billingStripeAccount.create({
      data: { stripeAccountId: 'acct_addon_contract_test', livemode: false },
    });
    const customer = await db.prisma.billingStripeCustomer.create({
      data: {
        accountId: stripeAccount.id,
        orgId: org.id,
        teamId: team.id,
        scope: BillingAssignmentScope.TEAM,
        scopeKey: `${org.id}:${team.id}`,
        stripeCustomerId: 'cus_addon_contract_test',
      },
    });
    const offer = await db.prisma.billingRecurringAddonOffer.create({
      data: {
        serviceId: service.id,
        key: 'privacy',
        version: 2,
        name: 'Private research',
        description: 'Private research add-on',
        monthlyAmountMinor: 5000n,
        currency: 'USD',
      },
    });
    const catalog = await db.prisma.billingRecurringAddonCatalog.create({
      data: {
        accountId: stripeAccount.id,
        serviceId: service.id,
        offerId: offer.id,
        currency: 'USD',
        monthlyAmountMinor: 5000n,
        stripeLookupKey: 'addon-contract-privacy-v2',
        stripeProductId: 'prod_addon_contract_test',
        stripePriceId: 'price_addon_contract_test',
      },
    });
    const checkout = await db.prisma.billingRecurringAddonCheckout.create({
      data: {
        accountId: stripeAccount.id,
        appKeyId: appKey.id,
        customerId: customer.id,
        catalogId: catalog.id,
        serviceId: service.id,
        offerId: offer.id,
        offerKey: offer.key,
        orgId: org.id,
        teamId: team.id,
        requestedTeamId: team.id,
        subscribingUserId: null,
        scope: BillingRecurringAddonSubscriptionScope.TEAM,
        scopeKey: `${org.id}:${team.id}`,
        actorJti: 'addon-contract-checkout-jti',
        subjectFingerprint: 'a'.repeat(64),
        requestedByUserId: owner.id,
        successUrlDigest: 'b'.repeat(64),
        cancelUrlDigest: 'c'.repeat(64),
        leaseExpiresAt: new Date('2026-05-30T12:05:00.000Z'),
      },
    });
    const checkoutCompletedAt = new Date('2026-05-30T12:00:00.000Z');
    const completionEvent = await db.prisma.billingStripeWebhookEvent.create({
      data: {
        accountId: stripeAccount.id,
        stripeEventId: 'evt_addon_contract_checkout',
        type: 'checkout.session.completed',
        livemode: false,
        stripeCreatedAt: checkoutCompletedAt,
        stripeObjectId: 'cs_addon_contract_test',
        stripeCustomerId: customer.stripeCustomerId,
        stripeCheckoutSessionId: 'cs_addon_contract_test',
        stripeSubscriptionId: 'sub_addon_contract_test',
      },
    });
    await db.prisma.billingRecurringAddonCheckout.update({
      where: { id: checkout.id },
      data: {
        status: BillingRecurringAddonCheckoutStatus.COMPLETE,
        stripeCheckoutSessionId: 'cs_addon_contract_test',
        stripeSubscriptionId: 'sub_addon_contract_test',
        completionWebhookEventId: completionEvent.id,
        completedAt: checkoutCompletedAt,
      },
    });
    const paidAt = new Date('2026-05-30T12:01:00.000Z');
    const paidEvent = await db.prisma.billingStripeWebhookEvent.create({
      data: {
        accountId: stripeAccount.id,
        stripeEventId: 'evt_addon_contract_paid',
        type: 'invoice.paid',
        livemode: false,
        stripeCreatedAt: paidAt,
        stripeObjectId: 'in_addon_contract_test',
        stripeCustomerId: customer.stripeCustomerId,
        stripeSubscriptionId: 'sub_addon_contract_test',
        stripeSubscriptionItemId: 'si_addon_contract_test',
        stripeInvoiceId: 'in_addon_contract_test',
        amountMinor: 5000n,
        currency: 'USD',
      },
    });
    const subscription = await db.prisma.billingRecurringAddonSubscription.create({
      data: {
        accountId: stripeAccount.id,
        checkoutId: checkout.id,
        customerId: customer.id,
        catalogId: catalog.id,
        serviceId: service.id,
        offerId: offer.id,
        offerKey: offer.key,
        orgId: org.id,
        teamId: team.id,
        subscribingUserId: null,
        scope: BillingRecurringAddonSubscriptionScope.TEAM,
        scopeKey: `${org.id}:${team.id}`,
        stripeSubscriptionId: 'sub_addon_contract_test',
        stripeItemId: 'si_addon_contract_test',
        status: 'active',
        initialInvoicePaidAt: paidAt,
        initialInvoiceId: 'in_addon_contract_test',
        activationWebhookEventId: paidEvent.id,
        entitlementActivatedAt: paidAt,
        livemode: false,
      },
    });

    const tariff = await db.prisma.billingTariff.create({
      data: {
        serviceId: service.id,
        key: 'addon-contract',
        version: 1,
        name: 'Add-on contract tariff',
        mode: BillingTariffMode.CUSTOM,
        collectionMode: BillingCollectionMode.MANUAL,
        markupBps: 2000,
        monthlyAmountMinor: 1000n,
        currency: 'USD',
        isDefault: false,
      },
    });
    const assignment = await db.prisma.billingTariffAssignment.create({
      data: {
        serviceId: service.id,
        tariffId: tariff.id,
        orgId: org.id,
        teamId: null,
        scope: BillingAssignmentScope.ORGANISATION,
        scopeKey: org.id,
      },
    });
    const contract = await db.prisma.billingOrganisationContract.create({
      data: { orgId: org.id, reference: 'addon-contract', name: 'Add-on Contract' },
    });
    const version = await db.prisma.billingOrganisationContractVersion.create({
      data: {
        contractId: contract.id,
        version: 1,
        usageMarkupBps: 2000,
        currency: 'USD',
        paymentTermsDays: 30,
        effectiveFromMonth: '2026-06',
      },
    });
    await db.prisma.billingContractServiceTerm.create({
      data: {
        contractVersionId: version.id,
        serviceId: service.id,
        tariffId: tariff.id,
        tariffAssignmentId: assignment.id,
        monthlyAmountMinor: 1000n,
      },
    });
    await db.prisma.billingOrganisationContract.update({
      where: { id: contract.id },
      data: {
        status: BillingOrganisationContractStatus.ACTIVE,
        activatedAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    });
    const issuer = await db.prisma.billingInvoiceIssuerProfile.create({
      data: {
        key: 'addon-contract-issuer',
        legalName: 'Unlike Other AI Ltd',
        billingEmail: 'billing@example.com',
        address: { line1: '1 Test St', city: 'London', postal_code: 'N1 1AA', country: 'GB' },
        invoiceNumberPrefix: 'UOAA',
      },
    });
    const buyer = await db.prisma.billingOrganisationInvoiceProfile.create({
      data: {
        orgId: org.id,
        legalName: 'Add-on Customer Ltd',
        billingEmail: 'ap@addon-customer.example',
        billingAddress: { line1: '2 Road', city: 'Bristol', postal_code: 'BS1 1AA', country: 'GB' },
      },
    });
    const invoice = await db.prisma.billingInvoice.create({
      data: {
        orgId: org.id,
        contractId: contract.id,
        contractVersionId: version.id,
        issuerProfileId: issuer.id,
        buyerProfileId: buyer.id,
        billingMonth: '2026-06',
        revision: 1,
        currency: 'USD',
        subtotalMinor: 1000n,
        totalMinor: 1000n,
        issuerSnapshot: { legal_name: issuer.legalName, billing_email: issuer.billingEmail },
        buyerSnapshot: { legal_name: buyer.legalName, billing_email: buyer.billingEmail },
        calculationDigest: 'd'.repeat(64),
        lines: {
          create: {
            serviceId: service.id,
            serviceIdentifier: service.identifier,
            serviceName: service.name,
            amountMinor: 1000n,
            currency: 'USD',
            position: 1,
          },
        },
        meteringRefs: {
          create: {
            serviceId: service.id,
            ledgerSnapshotCursor: 'addon-contract-metering',
            ledgerSnapshotSha256: 'e'.repeat(64),
            capturedAt: new Date('2026-07-01T00:00:00.000Z'),
          },
        },
        addonLines: {
          create: {
            serviceId: service.id,
            serviceIdentifier: service.identifier,
            serviceName: service.name,
            addonSubscriptionId: subscription.id,
            offerId: offer.id,
            offerVersion: offer.version,
            catalogId: catalog.id,
            offerKey: offer.key,
            offerName: offer.name,
            monthlyAmountMinor: offer.monthlyAmountMinor,
            currency: offer.currency,
            scope: subscription.scope,
            position: 1,
          },
        },
      },
      include: { addonLines: true },
    });

    expect(invoice.subtotalMinor).toBe(1000n);
    expect(invoice.totalMinor).toBe(1000n);
    expect(invoice.addonLines).toEqual([
      expect.objectContaining({
        addonSubscriptionId: subscription.id,
        serviceIdentifier: service.identifier,
        offerVersion: 2,
        monthlyAmountMinor: 5000n,
        collection: 'STRIPE_SEPARATE',
      }),
    ]);
  }, 120_000);
});
