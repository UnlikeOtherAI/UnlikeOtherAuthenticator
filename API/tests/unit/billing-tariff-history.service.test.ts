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
          { effectiveFromMonth: '2026-08', contractId: 'contract_1', serviceTerms: [{}] },
          { effectiveFromMonth: '2026-08', contractId: 'contract_2', serviceTerms: [{}] },
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
        { effectiveFromMonth: '2026-09', contractId: 'contract_1', serviceTerms: [] },
        { effectiveFromMonth: '2026-07', contractId: 'contract_1', serviceTerms: [
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
});
