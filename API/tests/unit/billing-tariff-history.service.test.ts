import { describe, expect, it, vi } from 'vitest';

import { resolveBillingTariffForMonth } from '../../src/services/billing-tariff-history.service.js';

describe('manual contract term history', () => {
  it('uses the explicitly effective immutable contract version before legacy pointer coverage', async () => {
    const tariff = { id: 'contract-tariff', serviceId: 'service_1', markupBps: 1750 };
    const reader = {
      billingService: {
        findUnique: vi.fn().mockResolvedValue({ tariffHistoryFromMonth: '2026-10' }),
      },
      billingOrganisationContractVersion: {
        findMany: vi.fn().mockResolvedValue([{
          effectiveFromMonth: '2026-07', contractId: 'contract_1',
          contract: { status: 'ACTIVE', terminatedAt: null },
          serviceTerms: [{ tariff, tariffAssignmentId: 'assignment_1' }],
        }]),
      },
      billingTariffTermEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const result = await resolveBillingTariffForMonth(reader as never, {
      serviceId: 'service_1', organisationId: 'org_1', teamId: 'team_1',
      billingMonth: '2026-08',
    });
    expect(result.tariff).toBe(tariff);
    expect(result.assignmentId).toBe('assignment_1');
    expect(reader.billingTariffTermEvent.findFirst).not.toHaveBeenCalled();
  });

  it('refuses two different contracts claiming the same month and service', async () => {
    const reader = {
      billingService: {
        findUnique: vi.fn().mockResolvedValue({ tariffHistoryFromMonth: '2026-07' }),
      },
      billingOrganisationContractVersion: {
        findMany: vi.fn().mockResolvedValue([
          { effectiveFromMonth: '2026-08', contractId: 'contract_1',
            contract: { status: 'ACTIVE', terminatedAt: null }, serviceTerms: [{}] },
          { effectiveFromMonth: '2026-08', contractId: 'contract_2',
            contract: { status: 'ACTIVE', terminatedAt: null }, serviceTerms: [{}] },
        ]),
      },
    };
    await expect(resolveBillingTariffForMonth(reader as never, {
      serviceId: 'service_1', organisationId: 'org_1', teamId: 'team_1',
      billingMonth: '2026-08',
    })).rejects.toThrow('BILLING_CONTRACT_TERMS_CONFLICT');
  });

  it('drops a service at the later complete contract version boundary', async () => {
    const reader = {
      billingService: {
        findUnique: vi.fn().mockResolvedValue({ tariffHistoryFromMonth: '2026-07' }),
      },
      billingOrganisationContractVersion: { findMany: vi.fn().mockResolvedValue([
        { effectiveFromMonth: '2026-09', contractId: 'contract_1',
          contract: { status: 'ACTIVE', terminatedAt: null }, serviceTerms: [] },
        { effectiveFromMonth: '2026-07', contractId: 'contract_1',
          contract: { status: 'ACTIVE', terminatedAt: null }, serviceTerms: [
          { tariff: { id: 'old_contract', serviceId: 'service_1' } },
        ] },
      ]) },
      billingTariffTermEvent: { findFirst: vi.fn().mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ tariffId: 'ordinary', tariff: {
          id: 'ordinary', serviceId: 'service_1' }, assignmentId: null }) },
    };
    const result = await resolveBillingTariffForMonth(reader as never, {
      serviceId: 'service_1', organisationId: 'org_1', teamId: 'team_1',
      billingMonth: '2026-09',
    });
    expect(result.tariff.id).toBe('ordinary');
  });

  it('ends a terminated contract at an exact UTC month boundary', async () => {
    const reader = {
      billingService: { findUnique: vi.fn().mockResolvedValue({ tariffHistoryFromMonth: '2026-07' }) },
      billingOrganisationContractVersion: { findMany: vi.fn().mockResolvedValue([{
        effectiveFromMonth: '2026-07', contractId: 'contract_1',
        contract: { status: 'TERMINATED', terminatedAt: new Date('2026-10-01T00:00:00Z') },
        serviceTerms: [{ tariffId: 'contract-tariff', tariff: {
          id: 'contract-tariff', serviceId: 'service_1' } }],
      }]) },
      billingTariffTermEvent: { findFirst: vi.fn().mockImplementation(
        ({ where }: { where: { scopeKey: string } }) => where.scopeKey === 'org_1:team_1'
          ? null : { tariffId: 'ordinary', tariff: { id: 'ordinary', serviceId: 'service_1' },
            assignmentId: null },
      ) },
    };
    const september = await resolveBillingTariffForMonth(reader as never, {
      serviceId: 'service_1', organisationId: 'org_1', teamId: 'team_1',
      billingMonth: '2026-09',
    });
    const october = await resolveBillingTariffForMonth(reader as never, {
      serviceId: 'service_1', organisationId: 'org_1', teamId: 'team_1',
      billingMonth: '2026-10',
    });
    expect(september.tariff.id).toBe('contract-tariff');
    expect(october.tariff.id).toBe('ordinary');
  });

  it('holds a partial termination month and stale contract pointer after termination', async () => {
    const reader = {
      billingService: { findUnique: vi.fn().mockResolvedValue({ tariffHistoryFromMonth: '2026-07' }) },
      billingOrganisationContractVersion: { findMany: vi.fn().mockResolvedValue([{
        effectiveFromMonth: '2026-07', contractId: 'contract_1',
        contract: { status: 'TERMINATED', terminatedAt: new Date('2026-10-15T12:00:00Z') },
        serviceTerms: [{ tariffId: 'contract-tariff', tariff: {
          id: 'contract-tariff', serviceId: 'service_1' } }],
      }]) },
      billingTariffTermEvent: { findFirst: vi.fn().mockResolvedValue({
        tariffId: 'contract-tariff', tariff: { id: 'contract-tariff', serviceId: 'service_1' },
      }) },
    };
    await expect(resolveBillingTariffForMonth(reader as never, {
      serviceId: 'service_1', organisationId: 'org_1', teamId: 'team_1',
      billingMonth: '2026-10',
    })).rejects.toThrow('BILLING_CONTRACT_TERMINATION_MONTH_RECONCILIATION_REQUIRED');
    await expect(resolveBillingTariffForMonth(reader as never, {
      serviceId: 'service_1', organisationId: 'org_1', teamId: 'team_1',
      billingMonth: '2026-11',
    })).rejects.toThrow('BILLING_TARIFF_HISTORY_RECONCILIATION_REQUIRED');
  });
});
