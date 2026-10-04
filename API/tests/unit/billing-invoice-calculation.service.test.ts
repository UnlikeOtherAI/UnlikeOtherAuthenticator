import { BillingCollectionMode, BillingTariffMode } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { calculateBillingContractInvoice } from '../../src/services/billing-invoice-calculation.service.js';
import type { NormalizedMeteringUsage } from '../../src/services/billing-metering.types.js';

const now = new Date('2026-07-20T12:00:00.000Z');

function usage(): NormalizedMeteringUsage {
  return {
    schemaVersion: 1,
    billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
    product: 'deepwater',
    groupBy: 'service',
    scope: {
      organizationId: 'org_1',
      teamId: null,
      userId: null,
      month: '2026-06',
      startsAt: '2026-06-01T00:00:00.000Z',
      endsAt: '2026-07-01T00:00:00.000Z',
    },
    calls: '1',
    lines: [
      {
        serviceId: 'openai',
        usageUnit: 'tokens',
        calls: '1',
        inputUnits: '100',
        cachedInputUnits: '0',
        outputUnits: '20',
        estimatedProviderCost: null,
        actualProviderCost: '2',
        selectedProviderCost: '2',
        currency: 'USD',
        costProvenance: 'provider_invoice',
        billingDisposition: 'paid',
        billingProduct: 'deepwater',
        callerProduct: 'nessie',
        originProduct: 'nessie',
        userId: null,
      },
    ],
    snapshot: {
      cursor: 'mus_0123456789ABCDEFGHIJKLMNOPQRSTUV',
      id: 'mus_0123456789ABCDEFGHIJKLMNOPQRSTUV',
      capturedAt: '2026-07-02T00:00:00.000Z',
      immutable: true,
      sha256: 'a'.repeat(64),
    },
  };
}

describe('contract invoice calculator', () => {
  it('rates one org-wide Ledger snapshot and stores only final service price plus private refs', async () => {
    const created = {
      id: 'invoice_1',
      orgId: 'org_1',
      contractId: 'contract_1',
      contractVersionId: 'version_1',
      issuerProfileId: 'issuer_1',
      buyerProfileId: 'buyer_1',
      billingMonth: '2026-06',
      revision: 1,
      status: 'DRAFT',
      invoiceNumber: null,
      issueDate: null,
      dueDate: null,
      currency: 'USD',
      subtotalMinor: 1250n,
      taxAmountMinor: 0n,
      totalMinor: 1550n,
      creditsAppliedMinor: 50n,
      issuerSnapshot: {},
      buyerSnapshot: {},
      calculationDigest: 'a'.repeat(64),
      pdfObjectKey: null,
      pdfSha256: null,
      pdfTemplateVersion: null,
      issuedAt: null,
      voidedAt: null,
      voidReason: null,
      createdByUserId: null,
      createdByEmail: null,
      createdAt: now,
      updatedAt: now,
      lines: [{ id: 'line_1', serviceId: 'service_1', amountMinor: 1250n }],
      addonLines: [],
      paymentEvents: [],
    };
    const createInvoice = vi.fn().mockResolvedValue(created);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ locked: '' }]),
      billingInvoice: {
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ revision: 3 }),
        create: createInvoice,
      },
      billingInvoiceCreditSettlementReference: { findMany: vi.fn().mockResolvedValue([{
        id: 'reference_1', serviceId: 'service_1', settlementId: 'settlement_1',
        creditsAppliedMicrocredits: 500_000_000n,
      }]) },
      billingInvoiceLineFinancialAllocation: { create: vi.fn() },
      billingInvoiceLineCreditReferenceAllocation: { create: vi.fn() },
      adminAuditLog: { create: vi.fn() },
    };
    const prisma = {
      billingOrganisationContract: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'contract_1',
          orgId: 'org_1',
          versions: [
            {
              id: 'version_1',
              usageMarkupBps: 2500,
              currency: 'USD',
              serviceTerms: [
                {
                  id: 'term_1',
                  serviceId: 'service_1',
                  tariffId: 'tariff_1',
                  monthlyAmountMinor: 1000n,
                  service: { id: 'service_1', identifier: 'deepwater', name: 'DeepWater' },
                  tariff: {
                    mode: BillingTariffMode.CUSTOM,
                    collectionMode: BillingCollectionMode.MANUAL,
                    markupBps: 2500,
                    monthlyAmountMinor: 1000n,
                    monthlyChargeBasis: 'FLAT',
                    usagePaymentMode: 'PAY_AS_YOU_GO',
                    currency: 'USD',
                  },
                },
              ],
            },
          ],
        }),
      },
      billingInvoiceIssuerProfile: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'issuer_1',
          legalName: 'UOA Ltd',
          tradingName: null,
          billingEmail: 'billing@example.com',
          address: {},
          taxIdentifier: null,
          companyRegistrationNumber: null,
        }),
      },
      billingOrganisationInvoiceProfile: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'buyer_1',
          legalName: 'Customer Ltd',
          billingEmail: 'ap@example.com',
          billingAddress: {},
          taxIdentifier: null,
          purchaseOrderReference: null,
        }),
      },
      $transaction: vi.fn(async (run: (value: typeof tx) => unknown) => run(tx)),
    };
    const fetchMetering = vi.fn().mockResolvedValue(usage());
    const collectFunding = vi.fn().mockResolvedValue({
      credits: [
        {
          accountId: 'credit_account_1',
          teamId: 'team_1',
          serviceId: 'service_1',
          settlementId: 'settlement_1',
          adjustmentId: 'settlement_adjustment_1',
          creditsAppliedMicrocredits: 500_000_000n,
        },
      ],
      addons: [
        {
          serviceId: 'service_1',
          serviceIdentifier: 'deepwater',
          serviceName: 'DeepWater',
          subscriptionId: 'addon_subscription_1',
          offerId: 'addon_offer_1',
          offerVersion: 2,
          catalogId: 'addon_catalog_1',
          offerKey: 'privacy',
          offerName: 'DeepWater Privacy',
          monthlyAmountMinor: 5000n,
          currency: 'USD',
          scope: 'ORGANISATION',
        },
      ],
    });
    const quoteMonthly = vi.fn().mockResolvedValue({
      serviceId: 'service_1', tariffId: 'tariff_1', currency: 'USD',
      chargeBasis: 'FLAT', amountMinor: 1000n,
    });

    await calculateBillingContractInvoice(
      {
        contractId: 'contract_1',
        issuerProfileId: 'issuer_1',
        billingMonth: '2026-06',
        taxTerms: { treatment: 'NO_TAX_CHARGED', rateBps: 0,
          legalBasis: 'Customer transaction outside tax scope' },
        actor: { email: 'admin@example.com' },
      },
      { prisma: prisma as never, fetchMetering, collectFunding, quoteMonthly, now: () => now },
    );

    expect(fetchMetering).toHaveBeenCalledWith(
      expect.objectContaining({ organisationId: 'org_1', teamId: null, groupBy: 'service' }),
    );
    const data = createInvoice.mock.calls[0]![0].data;
    expect(collectFunding).toHaveBeenCalledWith(
      expect.objectContaining({ tariffId: 'tariff_1', organisationId: 'org_1' }),
      { prisma },
    );
    expect(quoteMonthly).toHaveBeenCalledWith({
      source: { kind: 'manual', id: 'term_1' }, billingMonth: '2026-06',
    }, { prisma, now: expect.any(Function) });
    expect(data.subtotalMinor).toBe(1250n);
    expect(data.creditsAppliedMinor).toBe(50n);
    expect(tx.billingInvoiceLineFinancialAllocation.create).toHaveBeenCalledWith({ data:
      expect.objectContaining({ lineId: 'line_1', subscriptionMinor: 1000n,
        usageMinor: 250n, invoiceCreditMinor: 50n, dueMinor: 1200n }),
    });
    expect(tx.billingInvoiceLineCreditReferenceAllocation.create).toHaveBeenCalledWith({ data:
      expect.objectContaining({ referenceId: 'reference_1', lineId: 'line_1', amountMinor: 50n }),
    });
    expect(data.revision).toBe(4);
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.$queryRaw.mock.calls[0]?.[0]?.sql).toContain('::text AS "locked"');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.billingInvoice.findFirst.mock.invocationCallOrder[0]!,
    );
    expect(data.lines.create).toEqual([
      expect.objectContaining({
        serviceIdentifier: 'deepwater',
        amountMinor: 1250n,
        currency: 'USD',
      }),
    ]);
    expect(data.meteringRefs.create).toEqual([
      expect.objectContaining({
        ledgerSnapshotCursor: usage().snapshot.cursor,
        ledgerSnapshotSha256: usage().snapshot.sha256,
      }),
    ]);
    expect(data.creditSettlementRefs.create).toEqual([
      expect.objectContaining({
        settlementId: 'settlement_1',
        adjustmentId: 'settlement_adjustment_1',
        creditsAppliedMicrocredits: 500_000_000n,
      }),
    ]);
    expect(data.addonLines.create).toEqual([
      expect.objectContaining({
        serviceIdentifier: 'deepwater',
        offerVersion: 2,
        catalogId: 'addon_catalog_1',
        monthlyAmountMinor: 5000n,
      }),
    ]);
    expect(
      JSON.stringify(data.lines.create, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toMatch(/cost|token|markup|cursor|sha256/i);
  });

  it('rejects open months', async () => {
    await expect(
      calculateBillingContractInvoice(
        {
          contractId: 'contract_1',
          issuerProfileId: 'issuer_1',
          billingMonth: '2026-07',
          taxTerms: { treatment: 'NO_TAX_CHARGED', rateBps: 0,
            legalBasis: 'Customer transaction outside tax scope' },
          actor: { email: 'admin@example.com' },
        },
        { prisma: {} as never, now: () => now },
      ),
    ).rejects.toThrow('BILLING_INVOICE_MONTH_NOT_CLOSED');
  });

  it('stores the frozen per-seat quote as the manual monthly line and excludes prepaid usage', async () => {
    const createInvoice = vi.fn().mockResolvedValue({ id: 'draft_per_seat',
      billingMonth: '2026-06', currency: 'USD', calculationDigest: 'a'.repeat(64),
      lines: [{ id: 'line_1', serviceId: 'service_1', amountMinor: 1500n }] });
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ locked: '' }]),
      billingInvoice: { findFirst: vi.fn().mockResolvedValue(null), create: createInvoice },
      billingInvoiceCreditSettlementReference: { findMany: vi.fn().mockResolvedValue([]) },
      billingInvoiceLineFinancialAllocation: { create: vi.fn() },
      billingInvoiceLineCreditReferenceAllocation: { create: vi.fn() },
      adminAuditLog: { create: vi.fn() } };
    const prisma = {
      billingOrganisationContract: { findFirst: vi.fn().mockResolvedValue({
        id: 'contract_1', orgId: 'org_1', versions: [{ id: 'version_1',
          usageMarkupBps: 3000, currency: 'USD', serviceTerms: [{
            id: 'term_1', serviceId: 'service_1', tariffId: 'tariff_1',
            monthlyAmountMinor: 1000n,
            service: { identifier: 'deepwater', name: 'DeepWater' },
            tariff: { mode: BillingTariffMode.CUSTOM,
              collectionMode: BillingCollectionMode.MANUAL, markupBps: 3000,
              monthlyAmountMinor: 1000n, monthlyChargeBasis: 'PER_SEAT',
              usagePaymentMode: 'PREPAID', currency: 'USD' },
          }] }],
      }) },
      billingInvoiceIssuerProfile: { findFirst: vi.fn().mockResolvedValue({
        id: 'issuer_1', legalName: 'UOA Ltd', tradingName: null,
        billingEmail: 'billing@example.com', address: {},
        taxIdentifier: null, companyRegistrationNumber: null,
      }) },
      billingOrganisationInvoiceProfile: { findUnique: vi.fn().mockResolvedValue({
        id: 'buyer_1', legalName: 'Customer Ltd',
        billingEmail: 'ap@example.com', billingAddress: {},
        taxIdentifier: null, purchaseOrderReference: null,
      }) },
      $transaction: vi.fn(async (run: (value: typeof tx) => unknown) => run(tx)),
    };
    const quoteMonthly = vi.fn().mockResolvedValue({ agreementId: 'seat_1',
      serviceId: 'service_1', tariffId: 'tariff_1', currency: 'USD', chargeBasis: 'PER_SEAT',
      amountMinor: 1500n, seatMilliseconds: 1_500n,
      evidenceIds: ['interval_1', 'interval_2'] });
    const fetchMetering = vi.fn().mockResolvedValue(usage());
    const collectFunding = vi.fn().mockResolvedValue({ credits: [], addons: [] });
    const request = { contractId: 'contract_1',
      issuerProfileId: 'issuer_1', billingMonth: '2026-06',
      taxTerms: { treatment: 'NO_TAX_CHARGED' as const, rateBps: 0,
        legalBasis: 'Customer transaction outside tax scope' },
      actor: { email: 'admin@example.com' } };
    const deps = { prisma: prisma as never, now: () => now,
      fetchMetering, collectFunding, quoteMonthly };
    await calculateBillingContractInvoice(request, deps);
    expect(quoteMonthly).toHaveBeenCalledWith({
      source: { kind: 'manual', id: 'term_1' }, billingMonth: '2026-06',
    }, { prisma, now: expect.any(Function) });
    const invoice = createInvoice.mock.calls[0]![0].data;
    expect(invoice.subtotalMinor).toBe(1500n);
    expect(invoice.lines.create).toEqual([expect.objectContaining({
      amountMinor: 1500n, serviceIdentifier: 'deepwater',
    })]);
    expect(invoice.calculationDigest).toMatch(/^[a-f0-9]{64}$/);
    collectFunding.mockResolvedValue({ credits: [{ settlementId: 'legacy_prepaid_overlap' }],
      addons: [] });
    await expect(calculateBillingContractInvoice(request, deps))
      .rejects.toThrow('BILLING_INVOICE_PREPAID_CREDIT_CONFLICT');
    expect(createInvoice).toHaveBeenCalledOnce();
    collectFunding.mockResolvedValue({ credits: [], addons: [] });
    fetchMetering.mockResolvedValue({ ...usage(), billingCompleteness: {
      state: 'unresolved', unresolvedPaidAttempts: '1',
    } });
    await expect(calculateBillingContractInvoice(request, deps))
      .rejects.toThrow('LEDGER_METERING_UNRESOLVED_PAID_USAGE');
  });
});
