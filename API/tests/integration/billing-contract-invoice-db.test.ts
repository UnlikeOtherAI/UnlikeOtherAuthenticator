import {
  BillingAssignmentScope,
  BillingCollectionMode,
  BillingInvoicePaymentEventKind,
  BillingInvoicePaymentEventSource,
  BillingInvoiceStatus,
  BillingOrganisationContractStatus,
  BillingTariffMode,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

function monthAfter(value: string): string {
  const [year, month] = value.split('-').map(Number);
  const next = new Date(Date.UTC(year!, month!, 1));
  return next.toISOString().slice(0, 7);
}

describe.skipIf(!process.env.DATABASE_URL)('contract invoice database invariants', () => {
  let db: TestDb;

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('enforces version ordering, frozen calculation evidence, and credit-aware settlement', async () => {
    const owner = await db.prisma.user.create({
      data: {
        email: 'contract-owner@example.com',
        userKey: 'contract-owner@example.com',
        name: 'Contract Owner',
      },
    });
    const org = await db.prisma.organisation.create({
      data: {
        domain: 'contract-db.example',
        name: 'Contract Database Test',
        slug: 'contract-database-test',
        ownerId: owner.id,
      },
    });
    const services = await Promise.all(
      ['deepwater', 'nessie'].map((identifier) =>
        db.prisma.billingService.create({
          data: { identifier, name: identifier === 'deepwater' ? 'DeepWater' : 'Nessie' },
        }),
      ),
    );
    const contract = await db.prisma.billingOrganisationContract.create({
      data: {
        orgId: org.id,
        reference: 'db-contract',
        name: 'Database Contract',
        createdByEmail: 'admin@example.com',
      },
    });
    const versionOne = await db.prisma.billingOrganisationContractVersion.create({
      data: {
        contractId: contract.id,
        version: 1,
        usageMarkupBps: 2000,
        currency: 'USD',
        paymentTermsDays: 30,
        effectiveFromMonth: '2026-07',
        createdByEmail: 'admin@example.com',
      },
    });

    const raced = await Promise.allSettled(
      ['2026-08', '2026-09'].map((effectiveFromMonth) =>
        db.prisma.billingOrganisationContractVersion.create({
          data: {
            contractId: contract.id,
            version: 2,
            usageMarkupBps: 2000,
            currency: 'USD',
            paymentTermsDays: 30,
            effectiveFromMonth,
            createdByEmail: 'admin@example.com',
          },
        }),
      ),
    );
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const versionTwo = await db.prisma.billingOrganisationContractVersion.findUniqueOrThrow({
      where: { contractId_version: { contractId: contract.id, version: 2 } },
    });
    await expect(
      db.prisma.billingOrganisationContractVersion.create({
        data: {
          contractId: contract.id,
          version: 4,
          usageMarkupBps: 2000,
          currency: 'USD',
          paymentTermsDays: 30,
          effectiveFromMonth: monthAfter(versionTwo.effectiveFromMonth),
        },
      }),
    ).rejects.toThrow(/contract version must be contiguous/);
    await expect(
      db.prisma.billingOrganisationContractVersion.create({
        data: {
          contractId: contract.id,
          version: 3,
          usageMarkupBps: 2000,
          currency: 'USD',
          paymentTermsDays: 30,
          effectiveFromMonth: versionTwo.effectiveFromMonth,
        },
      }),
    ).rejects.toThrow(/contract version month must move forward/);
    await db.prisma.billingOrganisationContractVersion.create({
      data: {
        contractId: contract.id,
        version: 3,
        usageMarkupBps: 2000,
        currency: 'USD',
        paymentTermsDays: 30,
        effectiveFromMonth: monthAfter(versionTwo.effectiveFromMonth),
      },
    });

    await expect(
      db.prisma.$executeRawUnsafe(
        `INSERT INTO "billing_invoice_issuer_profiles"
          ("id", "key", "legal_name", "address", "invoice_number_prefix", "updated_at")
         VALUES ('issuer_missing_email', 'missing-email', 'Missing Email Ltd', '{}'::jsonb,
          'MISS', CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23502' } });

    const tariffs = await Promise.all(
      services.map((service, index) =>
        db.prisma.billingTariff.create({
          data: {
            serviceId: service.id,
            key: 'db-contract',
            version: 1,
            name: `${service.name} contract`,
            mode: BillingTariffMode.CUSTOM,
            collectionMode: BillingCollectionMode.MANUAL,
            markupBps: 2000,
            monthlyAmountMinor: 500n,
            currency: 'USD',
            isDefault: false,
            createdByEmail: `admin-${index}@example.com`,
          },
        }),
      ),
    );
    const assignments = await Promise.all(
      tariffs.map((tariff, index) =>
        db.prisma.billingTariffAssignment.create({
          data: {
            serviceId: services[index]!.id,
            tariffId: tariff.id,
            orgId: org.id,
            teamId: null,
            scope: BillingAssignmentScope.ORGANISATION,
            scopeKey: org.id,
            createdByEmail: 'admin@example.com',
          },
        }),
      ),
    );
    await Promise.all(
      services.map((service, index) =>
        db.prisma.billingContractServiceTerm.create({
          data: {
            contractVersionId: versionOne.id,
            serviceId: service.id,
            tariffId: tariffs[index]!.id,
            tariffAssignmentId: assignments[index]!.id,
            monthlyAmountMinor: 500n,
          },
        }),
      ),
    );
    await db.prisma.billingOrganisationContract.update({
      where: { id: contract.id },
      data: {
        status: BillingOrganisationContractStatus.ACTIVE,
        activatedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    });

    const issuer = await db.prisma.billingInvoiceIssuerProfile.create({
      data: {
        key: 'uoa-test',
        legalName: 'Unlike Other AI Ltd',
        tradingName: null,
        billingEmail: 'billing@example.com',
        address: { line1: '1 Test St', city: 'London', postal_code: 'N1 1AA', country: 'GB' },
        taxIdentifier: null,
        companyRegistrationNumber: null,
        invoiceNumberPrefix: 'UOAT',
      },
    });
    const buyer = await db.prisma.billingOrganisationInvoiceProfile.create({
      data: {
        orgId: org.id,
        legalName: 'Customer Ltd',
        billingEmail: 'ap@customer.example',
        billingAddress: {
          line1: '2 Customer Rd',
          city: 'Bristol',
          postal_code: 'BS1 1AA',
          country: 'GB',
        },
      },
    });
    const issuerSnapshot = {
      profile_id: issuer.id,
      legal_name: issuer.legalName,
      trading_name: null,
      billing_email: issuer.billingEmail,
      address: issuer.address,
      tax_identifier: null,
      company_registration_number: null,
    };
    const buyerSnapshot = {
      profile_id: buyer.id,
      legal_name: buyer.legalName,
      billing_email: buyer.billingEmail,
      billing_address: buyer.billingAddress,
      tax_identifier: null,
      purchase_order_reference: null,
    };
    const incomplete = await db.prisma.billingInvoice.create({
      data: {
        orgId: org.id,
        contractId: contract.id,
        contractVersionId: versionOne.id,
        issuerProfileId: issuer.id,
        buyerProfileId: buyer.id,
        billingMonth: '2026-07',
        revision: 1,
        currency: 'USD',
        subtotalMinor: 1000n,
        taxAmountMinor: 0n,
        totalMinor: 1000n,
        creditsAppliedMinor: 100n,
        issuerSnapshot,
        buyerSnapshot,
        calculationDigest: 'a'.repeat(64),
        lines: {
          create: {
            serviceId: services[0]!.id,
            serviceIdentifier: services[0]!.identifier,
            serviceName: services[0]!.name,
            amountMinor: 500n,
            currency: 'USD',
            position: 1,
          },
        },
        meteringRefs: {
          create: {
            serviceId: services[0]!.id,
            ledgerSnapshotCursor: 'snapshot-one',
            ledgerSnapshotSha256: 'b'.repeat(64),
            capturedAt: new Date('2026-08-01T00:00:00.000Z'),
          },
        },
      },
      include: { lines: true, meteringRefs: true },
    });
    await expect(
      db.prisma.billingInvoice.update({
        where: { id: incomplete.id },
        data: { subtotalMinor: 1100n, totalMinor: 1100n },
      }),
    ).rejects.toThrow(/calculated invoice commercial fields are immutable/);
    await expect(
      db.prisma.billingInvoiceLine.update({
        where: { id: incomplete.lines[0]!.id },
        data: { amountMinor: 600n },
      }),
    ).rejects.toThrow(/calculated invoice evidence is immutable/);
    await expect(
      db.prisma.billingInvoiceMeteringReference.update({
        where: { id: incomplete.meteringRefs[0]!.id },
        data: { ledgerSnapshotCursor: 'changed' },
      }),
    ).rejects.toThrow(/calculated invoice evidence is immutable/);
    await expect(
      db.prisma.billingInvoiceLine.create({
        data: {
          invoiceId: incomplete.id,
          serviceId: services[1]!.id,
          serviceIdentifier: services[1]!.identifier,
          serviceName: services[1]!.name,
          amountMinor: 500n,
          currency: 'USD',
          position: 2,
        },
      }),
    ).rejects.toThrow(/calculated invoice evidence is immutable/);

    const invoice = await db.prisma.billingInvoice.create({
      data: {
        orgId: org.id,
        contractId: contract.id,
        contractVersionId: versionOne.id,
        issuerProfileId: issuer.id,
        buyerProfileId: buyer.id,
        billingMonth: '2026-07',
        revision: 2,
        currency: 'USD',
        subtotalMinor: 1000n,
        taxAmountMinor: 0n,
        totalMinor: 1000n,
        creditsAppliedMinor: 0n,
        issuerSnapshot,
        buyerSnapshot,
        calculationDigest: 'c'.repeat(64),
        lines: {
          create: services.map((service, index) => ({
            serviceId: service.id,
            serviceIdentifier: service.identifier,
            serviceName: service.name,
            amountMinor: 500n,
            currency: 'USD',
            position: index + 1,
          })),
        },
        meteringRefs: {
          create: services.map((service) => ({
            serviceId: service.id,
            ledgerSnapshotCursor: `snapshot-${service.identifier}`,
            ledgerSnapshotSha256: 'd'.repeat(64),
            capturedAt: new Date('2026-08-01T00:00:00.000Z'),
          })),
        },
      },
    });
    const revisionRace = await Promise.allSettled(
      ['f', '9'].map((digestCharacter) =>
        db.prisma.billingInvoice.create({
          data: {
            orgId: org.id,
            contractId: contract.id,
            contractVersionId: versionOne.id,
            issuerProfileId: issuer.id,
            buyerProfileId: buyer.id,
            billingMonth: '2026-07',
            revision: 3,
            currency: 'USD',
            subtotalMinor: 1000n,
            taxAmountMinor: 0n,
            totalMinor: 1000n,
            creditsAppliedMinor: 0n,
            issuerSnapshot,
            buyerSnapshot,
            calculationDigest: digestCharacter.repeat(64),
            lines: {
              create: services.map((service, index) => ({
                serviceId: service.id,
                serviceIdentifier: service.identifier,
                serviceName: service.name,
                amountMinor: 500n,
                currency: 'USD',
                position: index + 1,
              })),
            },
            meteringRefs: {
              create: services.map((service) => ({
                serviceId: service.id,
                ledgerSnapshotCursor: `revision-race-${digestCharacter}-${service.identifier}`,
                ledgerSnapshotSha256: digestCharacter.repeat(64),
                capturedAt: new Date('2026-08-01T00:00:00.000Z'),
              })),
            },
          },
        }),
      ),
    );
    expect(revisionRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejectedRevision = revisionRace.find((result) => result.status === 'rejected');
    expect(rejectedRevision).toMatchObject({ status: 'rejected' });
    expect((rejectedRevision as PromiseRejectedResult).reason.message).toMatch(
      /invoice revision must be contiguous/,
    );
    const issuedAt = new Date('2026-08-02T00:00:00.000Z');
    await db.prisma.billingInvoice.update({
      where: { id: invoice.id },
      data: {
        status: BillingInvoiceStatus.ISSUING,
        invoiceNumber: 'UOAT-2026-000001',
        issueDate: issuedAt,
        dueDate: new Date('2026-09-01T00:00:00.000Z'),
      },
    });
    await db.prisma.billingInvoice.update({
      where: { id: invoice.id },
      data: {
        status: BillingInvoiceStatus.ISSUED,
        pdfObjectKey: `billing-invoices/${org.id}/${invoice.id}.pdf`,
        pdfSha256: 'e'.repeat(64),
        pdfTemplateVersion: 'test-v1',
        issuedAt,
      },
    });
    for (const data of [
      { invoiceNumber: 'UOAT-2026-999999' },
      { issueDate: new Date('2026-08-03T00:00:00.000Z') },
      { dueDate: new Date('2026-09-02T00:00:00.000Z') },
    ]) {
      await expect(
        db.prisma.billingInvoice.update({ where: { id: invoice.id }, data }),
      ).rejects.toThrow(/issued invoice identity and dates are immutable/);
    }
    await expect(
      db.prisma.billingInvoicePaymentEvent.create({
        data: {
          invoiceId: invoice.id,
          kind: BillingInvoicePaymentEventKind.PAYMENT,
          source: BillingInvoicePaymentEventSource.MANUAL,
          amountMinor: 1001n,
          currency: 'USD',
          idempotencyKey: 'too-much',
          occurredAt: issuedAt,
        },
      }),
    ).rejects.toThrow(/invoice settlement exceeds balance/);
    await db.prisma.billingInvoicePaymentEvent.create({
      data: {
        invoiceId: invoice.id,
        kind: BillingInvoicePaymentEventKind.PAYMENT,
        source: BillingInvoicePaymentEventSource.MANUAL,
        amountMinor: 1000n,
        currency: 'USD',
        idempotencyKey: 'exact-balance',
        occurredAt: issuedAt,
      },
    });
    const activatedAt = new Date('2026-07-01T00:00:00.000Z');
    await expect(
      db.prisma.billingOrganisationContract.update({
        where: { id: contract.id },
        data: { activatedAt: new Date('2026-07-02T00:00:00.000Z') },
      }),
    ).rejects.toThrow(/contract activation timestamp is immutable/);
    const terminatedAt = new Date('2026-08-03T00:00:00.000Z');
    await db.prisma.billingOrganisationContract.update({
      where: { id: contract.id },
      data: { status: BillingOrganisationContractStatus.TERMINATED, terminatedAt },
    });
    await expect(
      db.prisma.billingOrganisationContract.update({
        where: { id: contract.id },
        data: { activatedAt, terminatedAt: new Date('2026-08-04T00:00:00.000Z') },
      }),
    ).rejects.toThrow(/contract termination timestamp is immutable/);
  }, 120_000);
});
