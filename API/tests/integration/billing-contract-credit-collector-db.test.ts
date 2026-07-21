import {
  BillingAppKeyPurpose,
  BillingAssignmentScope,
  BillingCollectionMode,
  BillingCreditEntryDirection,
  BillingCreditEntryKind,
  BillingInvoicePaymentEventKind,
  BillingInvoicePaymentEventSource,
  BillingInvoiceStatus,
  BillingOrganisationContractStatus,
  BillingTariffMode,
  Prisma,
  UserRole,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

describe.skipIf(!process.env.DATABASE_URL)('contract invoice canonical credit collector', () => {
  let db: TestDb;

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('credits funded usage once and invoices only the uncovered remainder', async () => {
    const owner = await db.prisma.user.create({
      data: {
        email: 'credit-contract-owner@example.com',
        userKey: 'credit-contract-owner@example.com',
      },
    });
    const adminDomain = 'billing-admin.example.com';
    await db.prisma.domainRole.create({
      data: { domain: adminDomain, userId: owner.id, role: UserRole.SUPERUSER },
    });
    const org = await db.prisma.organisation.create({
      data: {
        domain: 'credit-contract.example',
        name: 'Credit Contract Test',
        slug: 'credit-contract-test',
        ownerId: owner.id,
      },
    });
    const team = await db.prisma.team.create({
      data: { orgId: org.id, name: 'Credit Team', slug: 'credit-team' },
    });
    const service = await db.prisma.billingService.create({
      data: { identifier: 'credit-contract-service', name: 'Credit Contract Service' },
    });
    const appKey = await db.prisma.billingAppKey.create({
      data: {
        serviceId: service.id,
        purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
        name: 'Credit contract test key',
        keyPrefix: 'uoa_credit_test',
        secretDigest: 'credit-contract-test-secret-digest',
        actorIssuer: 'https://credit-contract.example',
        actorAudience: 'https://authentication.unlikeotherai.com',
        actorKeyId: 'credit-contract-key',
        actorPublicJwk: { kty: 'RSA', n: 'AQAB', e: 'AQAB' },
        checkoutReturnOrigins: ['https://credit-contract.example'],
      },
    });
    const tariff = await db.prisma.billingTariff.create({
      data: {
        serviceId: service.id,
        key: 'credit-contract',
        version: 1,
        name: 'Credit contract tariff',
        mode: BillingTariffMode.CUSTOM,
        collectionMode: BillingCollectionMode.MANUAL,
        markupBps: 2000,
        monthlyAmountMinor: 0n,
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
      data: { orgId: org.id, reference: 'credit-contract', name: 'Credit Contract' },
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
        monthlyAmountMinor: 0n,
      },
    });
    await db.prisma.billingOrganisationContract.update({
      where: { id: contract.id },
      data: {
        status: BillingOrganisationContractStatus.ACTIVE,
        activatedAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    });
    const stripeAccount = await db.prisma.billingStripeAccount.create({
      data: { stripeAccountId: 'acct_credit_contract_test', livemode: false },
    });
    const customer = await db.prisma.billingStripeCustomer.create({
      data: {
        accountId: stripeAccount.id,
        orgId: org.id,
        teamId: team.id,
        scope: BillingAssignmentScope.TEAM,
        scopeKey: `${org.id}:${team.id}`,
        stripeCustomerId: 'cus_credit_contract_test',
      },
    });
    const creditAccount = await db.prisma.billingCreditAccount.create({
      data: {
        accountId: stripeAccount.id,
        customerId: customer.id,
        orgId: org.id,
        teamId: team.id,
        currency: 'USD',
      },
    });

    const fundingAdjustmentId = 'credit_contract_funding_adjustment';
    const fundingEntryId = 'credit_contract_funding_entry';
    await db.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.admin_auth_domain', ${adminDomain}, true)`,
      );
      await tx.billingCreditAdminAdjustment.create({
        data: {
          id: fundingAdjustmentId,
          accountId: stripeAccount.id,
          creditAccountId: creditAccount.id,
          orgId: org.id,
          teamId: team.id,
          signedAmountMicrocredits: 5_000_000_000n,
          reason: 'Contract invoice integration funding',
          idempotencyKey: 'credit-contract-funding',
          createdByUserId: owner.id,
          createdByEmail: owner.email,
          createdByAdminDomain: adminDomain,
          creditEntryId: fundingEntryId,
        },
      });
      await tx.billingCreditEntry.create({
        data: {
          id: fundingEntryId,
          creditAccountId: creditAccount.id,
          direction: BillingCreditEntryDirection.CREDIT,
          kind: BillingCreditEntryKind.ADJUSTMENT,
          amountMicrocredits: 5_000_000_000n,
          balanceAfterMicrocredits: 5_000_000_000n,
          currency: 'USD',
          idempotencyKey: 'credit-contract-funding',
          sourceType: 'credit_admin_adjustment',
          sourceId: fundingAdjustmentId,
          occurredAt: new Date('2026-06-30T23:00:00.000Z'),
        },
      });
    });

    const snapshot = await db.prisma.billingCreditPortfolioSnapshot.create({
      data: {
        accountId: stripeAccount.id,
        creditAccountId: creditAccount.id,
        orgId: org.id,
        teamId: team.id,
        perspectiveServiceId: service.id,
        perspectiveProduct: service.identifier,
        billingMonth: '2026-06',
        ledgerSnapshotId: 'mup_credit_contract_test',
        ledgerSnapshotCursor: 'mup_credit_contract_test',
        capturedAt: new Date('2026-07-01T00:00:00.000Z'),
        sha256: 'a'.repeat(64),
      },
    });
    const settlement = await db.prisma.billingCreditUsageSettlement.create({
      data: {
        accountId: stripeAccount.id,
        creditAccountId: creditAccount.id,
        tariffId: tariff.id,
        serviceId: service.id,
        appKeyId: appKey.id,
        billingMonth: '2026-06',
        currency: 'USD',
      },
    });
    const usageEntryId = 'credit_contract_usage_entry';
    const settlementAdjustmentId = 'credit_contract_settlement_adjustment';
    await db.prisma.$transaction(async (tx) => {
      await tx.billingCreditEntry.create({
        data: {
          id: usageEntryId,
          creditAccountId: creditAccount.id,
          serviceId: service.id,
          appKeyId: appKey.id,
          direction: BillingCreditEntryDirection.DEBIT,
          kind: BillingCreditEntryKind.USAGE_SETTLEMENT,
          amountMicrocredits: 10n,
          balanceAfterMicrocredits: 4_999_999_990n,
          currency: 'USD',
          idempotencyKey: 'credit-contract-usage',
          sourceType: 'credit_usage_settlement_adjustment',
          sourceId: settlementAdjustmentId,
          occurredAt: new Date('2026-07-01T00:00:00.000Z'),
        },
      });
      await tx.billingCreditUsageSettlementAdjustment.create({
        data: {
          id: settlementAdjustmentId,
          settlementId: settlement.id,
          accountId: stripeAccount.id,
          creditAccountId: creditAccount.id,
          serviceId: service.id,
          appKeyId: appKey.id,
          portfolioSnapshotId: snapshot.id,
          sequence: 1,
          deltaRatedUsageAmountMicroMinor: 1_000_000_000n,
          deltaCreditsConsumedMicrocredits: 10n,
          deltaRemainingUsageAmountMicroMinor: 999_999_999n,
          cumulativeRatedUsageAmountMicroMinor: 1_000_000_000n,
          cumulativeCreditsConsumedMicrocredits: 10n,
          cumulativeRemainingUsageAmountMicroMinor: 999_999_999n,
          creditEntryId: usageEntryId,
        },
      });
      await tx.billingCreditUsageAllocation.create({
        data: {
          settlementId: settlement.id,
          adjustmentId: settlementAdjustmentId,
          serviceId: service.id,
          appKeyId: appKey.id,
          attributedUserId: null,
          deltaRatedUsageAmountMicroMinor: 1_000_000_000n,
          deltaCreditsConsumedMicrocredits: 10n,
          deltaRemainingUsageAmountMicroMinor: 999_999_999n,
          cumulativeRatedUsageAmountMicroMinor: 1_000_000_000n,
          cumulativeCreditsConsumedMicrocredits: 10n,
          cumulativeRemainingUsageAmountMicroMinor: 999_999_999n,
        },
      });
    });

    const issuer = await db.prisma.billingInvoiceIssuerProfile.create({
      data: {
        key: 'credit-contract-issuer',
        legalName: 'Unlike Other AI Ltd',
        billingEmail: 'billing@example.com',
        address: { line1: '1 Test St', city: 'London', postal_code: 'N1 1AA', country: 'GB' },
        invoiceNumberPrefix: 'UOAC',
      },
    });
    const buyer = await db.prisma.billingOrganisationInvoiceProfile.create({
      data: {
        orgId: org.id,
        legalName: 'Credit Customer Ltd',
        billingEmail: 'ap@credit-customer.example',
        billingAddress: {
          line1: '2 Customer Rd',
          city: 'Bristol',
          postal_code: 'BS1 1AA',
          country: 'GB',
        },
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
        creditsAppliedMinor: 0n,
        issuerSnapshot: {
          profile_id: issuer.id,
          legal_name: issuer.legalName,
          billing_email: issuer.billingEmail,
        },
        buyerSnapshot: {
          profile_id: buyer.id,
          legal_name: buyer.legalName,
          billing_email: buyer.billingEmail,
        },
        calculationDigest: 'b'.repeat(64),
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
            ledgerSnapshotCursor: 'contract-invoice-metering-snapshot',
            ledgerSnapshotSha256: 'c'.repeat(64),
            capturedAt: new Date('2026-07-01T00:00:00.000Z'),
          },
        },
        creditSettlementRefs: {
          create: {
            serviceId: service.id,
            settlementId: settlement.id,
            adjustmentId: settlementAdjustmentId,
            creditsAppliedMicrocredits: 10n,
          },
        },
      },
    });

    const funded = await db.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: creditAccount.id },
    });
    expect(funded.balanceMicrocredits).toBe(4_999_999_990n);
    const readyBeforeIssue = await db.prisma.$queryRaw<Array<{ ready: boolean }>>(
      Prisma.sql`SELECT uoa_billing_invoice_issue_ready(${invoice.id}) AS "ready"`,
    );
    expect(readyBeforeIssue).toEqual([{ ready: true }]);
    const issueDate = new Date('2026-07-02T00:00:00.000Z');
    await db.prisma.billingInvoice.update({
      where: { id: invoice.id },
      data: {
        status: BillingInvoiceStatus.ISSUING,
        invoiceNumber: 'UOAC-2026-000001',
        issueDate,
        dueDate: new Date('2026-08-01T00:00:00.000Z'),
      },
    });
    await db.prisma.billingInvoice.update({
      where: { id: invoice.id },
      data: {
        status: BillingInvoiceStatus.ISSUED,
        pdfObjectKey: `billing-invoices/${org.id}/${invoice.id}.pdf`,
        pdfSha256: 'd'.repeat(64),
        pdfTemplateVersion: 'credit-collector-test-v1',
        issuedAt: issueDate,
      },
    });
    await expect(
      db.prisma.billingInvoice.update({
        where: { id: invoice.id },
        data: {
          status: BillingInvoiceStatus.VOID,
          voidedAt: issueDate,
          voidReason: 'Must be rejected despite the rounded $0.00 credit display',
        },
      }),
    ).rejects.toThrow(/settled invoices cannot be voided/);
    const correction = await db.prisma.billingInvoice.create({
      data: {
        orgId: org.id,
        contractId: contract.id,
        contractVersionId: version.id,
        issuerProfileId: issuer.id,
        buyerProfileId: buyer.id,
        billingMonth: '2026-06',
        revision: 2,
        currency: 'USD',
        subtotalMinor: 1000n,
        totalMinor: 1000n,
        creditsAppliedMinor: 0n,
        issuerSnapshot: {
          profile_id: issuer.id,
          legal_name: issuer.legalName,
          billing_email: issuer.billingEmail,
        },
        buyerSnapshot: {
          profile_id: buyer.id,
          legal_name: buyer.legalName,
          billing_email: buyer.billingEmail,
        },
        calculationDigest: 'e'.repeat(64),
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
            ledgerSnapshotCursor: 'contract-invoice-correction-snapshot',
            ledgerSnapshotSha256: 'f'.repeat(64),
            capturedAt: new Date('2026-07-01T00:00:00.000Z'),
          },
        },
      },
    });
    const correctionReadiness = await db.prisma.$queryRaw<Array<{ ready: boolean }>>(
      Prisma.sql`SELECT uoa_billing_invoice_issue_ready(${correction.id}) AS "ready"`,
    );
    expect(correctionReadiness).toEqual([{ ready: false }]);
    await expect(
      db.prisma.billingInvoice.update({
        where: { id: correction.id },
        data: {
          status: BillingInvoiceStatus.ISSUING,
          invoiceNumber: 'UOAC-2026-000002',
          issueDate,
          dueDate: new Date('2026-08-01T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow(/invoice is not ready for issuance/);
    await db.prisma.billingInvoicePaymentEvent.create({
      data: {
        invoiceId: invoice.id,
        kind: BillingInvoicePaymentEventKind.PAYMENT,
        source: BillingInvoicePaymentEventSource.MANUAL,
        amountMinor: 1000n,
        currency: 'USD',
        idempotencyKey: 'uncovered-remainder',
        occurredAt: issueDate,
      },
    });
    await expect(
      db.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE "billing_credit_invoice_lines" DISABLE TRIGGER "billing_credit_invoice_lines_coherence"',
        );
        await tx.billingCreditInvoiceLine.create({
          data: {
            accountId: stripeAccount.id,
            settlementId: settlement.id,
            subscriptionId: 'forbidden_subscription',
            lastAdjustmentId: settlementAdjustmentId,
            stripeInvoiceId: 'in_forbidden_double_collection',
            cumulativeCreditsConsumedMicrocredits: 10n,
            stripeQuantity: 1n,
            idempotencyKey: 'forbidden-double-collection',
          },
        });
      }),
    ).rejects.toThrow(/credit settlement already has a manual invoice collector/);
  }, 120_000);
});
