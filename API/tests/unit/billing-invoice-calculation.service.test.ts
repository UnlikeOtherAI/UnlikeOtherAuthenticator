import {
  BillingAdjustmentCadence,
  BillingAdjustmentKind,
  BillingAssignmentScope,
  BillingCollectionMode,
  BillingTariffMode,
} from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { calculateBillingContractInvoice } from '../../src/services/billing-invoice-calculation.service.js';
import type { NormalizedMeteringUsage } from '../../src/services/billing-metering.types.js';

const now = new Date('2026-07-20T12:00:00.000Z');

function usage(): NormalizedMeteringUsage {
  return {
    schemaVersion: 1,
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

function adjustment(
  id: string,
  kind: BillingAdjustmentKind,
  amountMinor: bigint,
  teamId: string | null,
) {
  return {
    id,
    serviceId: 'service_1',
    orgId: 'org_1',
    teamId,
    scope: teamId ? BillingAssignmentScope.TEAM : BillingAssignmentScope.ORGANISATION,
    scopeKey: teamId ? `org_1:${teamId}` : 'org_1',
    key: id,
    name: id,
    kind,
    cadence: BillingAdjustmentCadence.MONTHLY,
    amountMinor,
    currency: 'USD',
    startsAt: new Date('2026-01-01T00:00:00.000Z'),
    endsAt: null,
    active: true,
    deactivatedAt: null,
    createdByUserId: null,
    createdByEmail: null,
    createdAt: now,
    updatedAt: now,
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
      subtotalMinor: 1550n,
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
      lines: [],
      paymentEvents: [],
    };
    const createInvoice = vi.fn().mockResolvedValue(created);
    const tx = {
      billingInvoice: {
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ revision: 3 }),
        create: createInvoice,
      },
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
                  serviceId: 'service_1',
                  monthlyAmountMinor: 1000n,
                  service: { id: 'service_1', identifier: 'deepwater', name: 'DeepWater' },
                  tariff: {
                    mode: BillingTariffMode.CUSTOM,
                    collectionMode: BillingCollectionMode.MANUAL,
                    markupBps: 2500,
                    monthlyAmountMinor: 1000n,
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
      billingCommercialAdjustment: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            adjustment('org_addon', BillingAdjustmentKind.ADD_ON, 100n, null),
            adjustment('team_addon', BillingAdjustmentKind.ADD_ON, 200n, 'team_1'),
            adjustment('credit', BillingAdjustmentKind.CREDIT, 50n, 'team_2'),
          ]),
      },
      $transaction: vi.fn(async (run: (value: typeof tx) => unknown) => run(tx)),
    };
    const fetchMetering = vi.fn().mockResolvedValue(usage());

    await calculateBillingContractInvoice(
      {
        contractId: 'contract_1',
        issuerProfileId: 'issuer_1',
        billingMonth: '2026-06',
        actor: { email: 'admin@example.com' },
      },
      { prisma: prisma as never, fetchMetering, now: () => now },
    );

    expect(fetchMetering).toHaveBeenCalledWith(
      expect.objectContaining({ organisationId: 'org_1', teamId: null, groupBy: 'service' }),
    );
    const data = createInvoice.mock.calls[0]![0].data;
    expect(data.subtotalMinor).toBe(1550n);
    expect(data.creditsAppliedMinor).toBe(50n);
    expect(data.revision).toBe(4);
    expect(data.lines.create).toEqual([
      expect.objectContaining({
        serviceIdentifier: 'deepwater',
        amountMinor: 1550n,
        currency: 'USD',
      }),
    ]);
    expect(data.meteringRefs.create).toEqual([
      expect.objectContaining({
        ledgerSnapshotCursor: usage().snapshot.cursor,
        ledgerSnapshotSha256: usage().snapshot.sha256,
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
          actor: { email: 'admin@example.com' },
        },
        { prisma: {} as never, now: () => now },
      ),
    ).rejects.toThrow('BILLING_INVOICE_MONTH_NOT_CLOSED');
  });
});
