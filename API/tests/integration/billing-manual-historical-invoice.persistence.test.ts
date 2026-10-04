import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { calculateBillingContractInvoice } from '../../src/services/billing-invoice-calculation.service.js';
import type { NormalizedMeteringUsage } from '../../src/services/billing-metering.types.js';
import { createTestDb } from '../helpers/test-db.js';

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

describe.skipIf(!process.env.DATABASE_URL)('historical manual monthly invoice', () => {
  let db: TestDb;
  let contractId: string;
  let issuerProfileId: string;
  let serviceId: string;
  let orgId: string;

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const owner = await db.prisma.user.create({ data: {
      email: 'historical-billing-owner@example.test',
      userKey: 'historical-billing-owner@example.test',
    } });
    const org = await db.prisma.organisation.create({ data: {
      ownerId: owner.id, name: 'Historical billing',
      slug: 'historical-billing', domain: 'example.test',
    } });
    orgId = org.id;
    const service = await db.prisma.billingService.create({ data: {
      identifier: 'historical-billing-product', name: 'Historical product',
    } });
    serviceId = service.id;
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId, key: 'historical-billing', version: 1, name: 'Historical billing',
      mode: 'CUSTOM', collectionMode: 'MANUAL', markupBps: 3000,
      currency: 'USD', monthlyAmountMinor: 1300n,
      monthlyChargeBasis: 'FLAT', usagePaymentMode: 'PREPAID',
    } });
    const contract = await db.prisma.billingOrganisationContract.create({ data: {
      orgId, reference: 'historical-billing', name: 'Historical billing',
      status: 'ACTIVE', activatedAt: new Date('2026-08-01T00:00:00Z'),
    } });
    contractId = contract.id;
    const version = await db.prisma.billingOrganisationContractVersion.create({ data: {
      contractId, version: 1, usageMarkupBps: 3000, currency: 'USD',
      paymentTermsDays: 30, effectiveFromMonth: '2026-08',
    } });
    await db.prisma.billingContractServiceTerm.create({ data: {
      contractVersionId: version.id, serviceId, tariffId: tariff.id,
      monthlyAmountMinor: 1300n,
    } });
    const issuer = await db.prisma.billingInvoiceIssuerProfile.create({ data: {
      key: 'historical-billing', legalName: 'Unlike Other AI Ltd',
      billingEmail: 'billing@example.test', address: { country: 'GB' },
      invoiceNumberPrefix: 'HIST',
    } });
    issuerProfileId = issuer.id;
    await db.prisma.billingOrganisationInvoiceProfile.create({ data: {
      orgId, legalName: 'Historical Customer Ltd',
      billingEmail: 'customer@example.test', billingAddress: { country: 'GB' },
    } });
  });
  afterAll(async () => { if (db) await db.cleanup(); });

  function metering(): NormalizedMeteringUsage {
    return {
      schemaVersion: 1, product: 'historical-billing-product', groupBy: 'service',
      scope: { organizationId: orgId, teamId: null, userId: null, month: '2026-10',
        startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-11-01T00:00:00.000Z' },
      calls: '0', lines: [],
      billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
      snapshot: { id: 'historical-snapshot', cursor: 'historical-snapshot',
        capturedAt: '2026-11-01T00:00:00.000Z', immutable: true, sha256: 'a'.repeat(64) },
    };
  }

  it('issues a closed active month after later termination and rejects the later month', async () => {
    await db.prisma.billingOrganisationContract.update({ where: { id: contractId }, data: {
      status: 'TERMINATED', terminatedAt: new Date('2026-11-01T00:00:00Z'),
    } });
    const fetchMetering = vi.fn().mockResolvedValue(metering());
    const params = { contractId, issuerProfileId, billingMonth: '2026-10',
      taxTerms: { treatment: 'NO_TAX_CHARGED' as const, rateBps: 0,
        legalBasis: 'Customer transaction outside tax scope' },
      actor: { email: 'operator@example.test' } };
    const deps = { prisma: db.prisma, fetchMetering,
      collectFunding: vi.fn().mockResolvedValue({ credits: [], addons: [] }),
      now: () => new Date('2026-12-01T00:00:00Z') };
    const invoice = await calculateBillingContractInvoice(params, deps);
    expect(invoice.subtotalMinor).toBe(1300n);
    expect(invoice.creditsAppliedMinor).toBe(0n);
    expect(invoice.lines).toEqual([expect.objectContaining({ serviceId, amountMinor: 1300n })]);
    expect(await db.prisma.billingInvoiceLineFinancialAllocation.findMany({
      where: { invoiceId: invoice.id },
    })).toEqual([expect.objectContaining({ serviceId, subscriptionMinor: 1300n,
      usageMinor: 0n, invoiceCreditMinor: 0n, totalMinor: 1300n, dueMinor: 1300n })]);
    await expect(calculateBillingContractInvoice({ ...params, billingMonth: '2026-11' }, deps))
      .rejects.toThrow('BILLING_MONTHLY_SOURCE_NOT_EFFECTIVE');
    expect(fetchMetering).toHaveBeenCalledTimes(2);
  });

  it('freezes two different service liabilities in one draft without repeating a monthly fee', async () => {
    const service = await db.prisma.billingService.create({ data: {
      identifier: 'historical-second-product', name: 'Second product',
    } });
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId: service.id, key: 'historical-second', version: 1, name: 'Second product',
      mode: 'CUSTOM', collectionMode: 'MANUAL', markupBps: 3000,
      currency: 'USD', monthlyAmountMinor: 700n, monthlyChargeBasis: 'FLAT',
      usagePaymentMode: 'PREPAID',
    } });
    const contract = await db.prisma.billingOrganisationContract.create({ data: {
      orgId, reference: 'two-service-invoice', name: 'Two products', status: 'ACTIVE',
      activatedAt: new Date('2026-08-01T00:00:00Z'),
    } });
    const version = await db.prisma.billingOrganisationContractVersion.create({ data: {
      contractId: contract.id, version: 1, usageMarkupBps: 3000, currency: 'USD',
      paymentTermsDays: 30, effectiveFromMonth: '2026-08',
    } });
    const original = await db.prisma.billingContractServiceTerm.findFirstOrThrow({
      where: { serviceId },
    });
    await db.prisma.billingContractServiceTerm.createMany({ data: [
      { contractVersionId: version.id, serviceId, tariffId: original.tariffId,
        monthlyAmountMinor: 1300n },
      { contractVersionId: version.id, serviceId: service.id, tariffId: tariff.id,
        monthlyAmountMinor: 700n },
    ] });
    const params = { contractId: contract.id, issuerProfileId, billingMonth: '2026-09',
      taxTerms: { treatment: 'STANDARD_RATE' as const, rateBps: 2000,
        legalBasis: 'Standard VAT on taxable services' },
      actor: { email: 'operator@example.test' } };
    const deps = { prisma: db.prisma,
      fetchMetering: vi.fn().mockImplementation(async (input: { product: string }) => ({
        ...metering(), product: input.product,
      })),
      collectFunding: vi.fn().mockResolvedValue({ credits: [], addons: [] }),
      now: () => new Date('2026-12-01T00:00:00Z'),
    };
    const first = await calculateBillingContractInvoice(params, deps);
    const replay = await calculateBillingContractInvoice(params, deps);
    expect(replay.id).toBe(first.id);
    expect(first.subtotalMinor).toBe(2000n);
    expect(first.taxAmountMinor).toBe(400n);
    expect(first.totalMinor).toBe(2400n);
    const allocations = await db.prisma.billingInvoiceLineFinancialAllocation.findMany({
      where: { invoiceId: first.id }, orderBy: { subscriptionMinor: 'desc' },
    });
    expect(allocations.map((line) => [line.subscriptionMinor, line.usageMinor,
      line.invoiceCreditMinor, line.dueMinor])).toEqual([
      [1300n, 0n, 0n, 1560n], [700n, 0n, 0n, 840n],
    ]);
  });
});
