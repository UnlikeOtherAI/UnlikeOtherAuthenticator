import { BillingCollectionMode, BillingTariffMode } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { activateBillingContractVersion } from '../../src/services/billing-contract.service.js';

function version(values?: Record<string, unknown>) {
  return {
    id: 'version_1',
    version: 1,
    usageMarkupBps: 4000,
    currency: 'USD',
    paymentTermsDays: 30,
    effectiveFromMonth: '2026-07',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    serviceTerms: [],
    ...values,
  };
}

function setup(overrides?: {
  teamOverride?: { id: string } | null;
  checkout?: { id: string } | null;
  subscription?: { id: string } | null;
  versions?: ReturnType<typeof version>[];
  assignmentDrift?: boolean;
}) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ uoa_lock_stripe_contract_scope: null }]),
    billingOrganisationContract: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'contract_1',
        orgId: 'org_1',
        name: 'Enterprise',
        status: 'DRAFT',
        activatedAt: null,
        versions: overrides?.versions ?? [version()],
      }),
      update: vi.fn(),
    },
    billingService: {
      findMany: vi.fn().mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
        [
          { id: 'service_1', identifier: 'deepwater' },
          { id: 'service_2', identifier: 'nessie' },
        ].filter((service) => where.id.in.includes(service.id)),
      ),
    },
    billingTariffAssignment: {
      findFirst: vi.fn().mockResolvedValue(overrides?.teamOverride ?? null),
      findMany: vi.fn().mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => {
          const serviceId = id.replace('assignment_', '');
          return {
            id,
            serviceId,
            tariffId: overrides?.assignmentDrift ? 'tariff_drifted' : `tariff_old_${serviceId}`,
            orgId: 'org_1',
            teamId: null,
            scope: 'ORGANISATION',
            scopeKey: 'org_1',
          };
        }),
      ),
      delete: vi.fn(),
      upsert: vi.fn().mockImplementation(async ({ create }: { create: { serviceId: string } }) => ({
        id: `assignment_${create.serviceId}`,
      })),
    },
    billingStripeCheckoutSession: {
      findFirst: vi.fn().mockResolvedValue(overrides?.checkout ?? null),
    },
    billingStripeSubscription: {
      findFirst: vi.fn().mockResolvedValue(overrides?.subscription ?? null),
    },
    billingTariff: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: { data: { serviceId: string } }) => ({
        id: `tariff_${data.serviceId}`,
        ...data,
      })),
    },
    billingContractServiceTerm: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `term_${data.serviceId as string}`,
        ...data,
      })),
    },
    adminAuditLog: { create: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(async (run: (value: typeof tx) => unknown) => run(tx)),
  };
  return { tx, prisma };
}

describe('organisation contract activation', () => {
  it('atomically projects one immutable custom/manual tariff and org assignment per service', async () => {
    const { tx, prisma } = setup();

    await activateBillingContractVersion(
      {
        contractId: 'contract_1',
        contractVersionId: 'version_1',
        services: [
          { serviceId: 'service_1', monthlyAmountMinor: '5000' },
          { serviceId: 'service_2', monthlyAmountMinor: '1000' },
        ],
        actor: { email: 'admin@example.com' },
      },
      { prisma: prisma as never, now: () => new Date('2026-07-20T00:00:00.000Z') },
    );

    expect(tx.billingTariff.create).toHaveBeenCalledTimes(2);
    expect(tx.billingTariff.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        serviceId: 'service_1',
        mode: BillingTariffMode.CUSTOM,
        collectionMode: BillingCollectionMode.MANUAL,
        markupBps: 4000,
        monthlyAmountMinor: 5000n,
        currency: 'USD',
        isDefault: false,
      }),
    });
    expect(tx.billingTariffAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ orgId: 'org_1', teamId: null, scopeKey: 'org_1' }),
      }),
    );
    expect(tx.billingOrganisationContract.update).toHaveBeenCalledWith({
      where: { id: 'contract_1' },
      data: { status: 'ACTIVE', activatedAt: new Date('2026-07-20T00:00:00.000Z') },
    });
  });

  it('rejects any existing team override before creating tariffs', async () => {
    const { tx, prisma } = setup({ teamOverride: { id: 'assignment_team' } });

    await expect(
      activateBillingContractVersion(
        {
          contractId: 'contract_1',
          contractVersionId: 'version_1',
          services: [
            { serviceId: 'service_1', monthlyAmountMinor: '5000' },
            { serviceId: 'service_2', monthlyAmountMinor: '1000' },
          ],
          actor: { email: 'admin@example.com' },
        },
        { prisma: prisma as never },
      ),
    ).rejects.toThrow('BILLING_CONTRACT_TEAM_OVERRIDE_EXISTS');
    expect(tx.billingTariff.create).not.toHaveBeenCalled();
  });

  it('locks every covered service and rejects a completed Checkout awaiting projection', async () => {
    const { tx, prisma } = setup({ checkout: { id: 'checkout_complete' } });

    await expect(
      activateBillingContractVersion(
        {
          contractId: 'contract_1',
          contractVersionId: 'version_1',
          services: [
            { serviceId: 'service_2', monthlyAmountMinor: '1000' },
            { serviceId: 'service_1', monthlyAmountMinor: '5000' },
          ],
          actor: { email: 'admin@example.com' },
        },
        { prisma: prisma as never, now: () => new Date('2026-07-20T00:00:00.000Z') },
      ),
    ).rejects.toThrow('BILLING_CONTRACT_STRIPE_CONFLICT');

    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    for (const [query] of tx.$queryRaw.mock.calls) {
      expect(query.sql).toContain('::text AS "locked"');
    }
    expect(tx.billingStripeCheckoutSession.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        orgId: 'org_1',
        serviceId: { in: ['service_2', 'service_1'] },
        OR: expect.arrayContaining([expect.objectContaining({ status: 'complete' })]),
      }),
      select: { id: true },
    });
    expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      tx.billingStripeCheckoutSession.findFirst.mock.invocationCallOrder[0]!,
    );
    expect(tx.billingTariff.create).not.toHaveBeenCalled();
  });

  it('does not project a future-effective version early', async () => {
    const { tx, prisma } = setup({
      versions: [version({ effectiveFromMonth: '2026-08' })],
    });

    await expect(
      activateBillingContractVersion(
        {
          contractId: 'contract_1',
          contractVersionId: 'version_1',
          services: [{ serviceId: 'service_1', monthlyAmountMinor: '5000' }],
          actor: { email: 'admin@example.com' },
        },
        { prisma: prisma as never, now: () => new Date('2026-07-31T23:59:59.999Z') },
      ),
    ).rejects.toThrow('BILLING_CONTRACT_VERSION_NOT_EFFECTIVE');
    expect(tx.billingTariff.create).not.toHaveBeenCalled();
    expect(tx.billingTariffAssignment.upsert).not.toHaveBeenCalled();
  });

  it('removes a superseded live assignment when the next complete version drops a service', async () => {
    const oldTariff = {
      mode: BillingTariffMode.CUSTOM,
      collectionMode: BillingCollectionMode.MANUAL,
      markupBps: 2000,
      currency: 'USD',
    };
    const oldTerms = ['service_1', 'service_2'].map((serviceId) => ({
      id: `term_${serviceId}`,
      serviceId,
      tariffId: `tariff_old_${serviceId}`,
      tariffAssignmentId: `assignment_${serviceId}`,
      monthlyAmountMinor: 1000n,
      tariff: oldTariff,
    }));
    const { tx, prisma } = setup({
      versions: [
        version({ id: 'version_2', version: 2, effectiveFromMonth: '2026-08' }),
        version({ serviceTerms: oldTerms }),
      ],
    });

    await activateBillingContractVersion(
      {
        contractId: 'contract_1',
        contractVersionId: 'version_2',
        services: [{ serviceId: 'service_1', monthlyAmountMinor: '2000' }],
        actor: { email: 'admin@example.com' },
      },
      { prisma: prisma as never, now: () => new Date('2026-08-01T00:00:00.000Z') },
    );

    expect(tx.billingTariffAssignment.delete).toHaveBeenCalledOnce();
    expect(tx.billingTariffAssignment.delete).toHaveBeenCalledWith({
      where: { id: 'assignment_service_2' },
    });
  });

  it('rejects carried-assignment drift before tariff or assignment writes', async () => {
    const oldTerm = {
      id: 'term_service_1',
      serviceId: 'service_1',
      tariffId: 'tariff_old_service_1',
      tariffAssignmentId: 'assignment_service_1',
      monthlyAmountMinor: 1000n,
      tariff: {
        mode: BillingTariffMode.CUSTOM,
        collectionMode: BillingCollectionMode.MANUAL,
        markupBps: 2000,
        currency: 'USD',
      },
    };
    const { tx, prisma } = setup({
      assignmentDrift: true,
      versions: [
        version({ id: 'version_2', version: 2, effectiveFromMonth: '2026-08' }),
        version({ serviceTerms: [oldTerm] }),
      ],
    });

    await expect(
      activateBillingContractVersion(
        {
          contractId: 'contract_1',
          contractVersionId: 'version_2',
          services: [{ serviceId: 'service_1', monthlyAmountMinor: '2000' }],
          actor: { email: 'admin@example.com' },
        },
        { prisma: prisma as never, now: () => new Date('2026-08-01T00:00:00.000Z') },
      ),
    ).rejects.toThrow('BILLING_CONTRACT_ASSIGNMENT_DRIFT');
    expect(tx.billingTariff.create).not.toHaveBeenCalled();
    expect(tx.billingTariffAssignment.upsert).not.toHaveBeenCalled();
  });
});
