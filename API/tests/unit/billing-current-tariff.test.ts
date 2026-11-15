import { describe, expect, it, vi } from 'vitest';
import { resolveCurrentBillingTariff } from '../../src/services/billing-current-tariff.service.js';
import { resolveBillingTariffForMonth } from '../../src/services/billing-tariff-history.service.js';

const scope = { serviceId: 'svc', organisationId: 'org', teamId: 'team', billingMonth: '2026-11' };
const historical = { id: 'old', mode: 'AT_COST', collectionMode: 'NONE', currency: 'USD' };
const regular = { id: 'regular', mode: 'STANDARD', collectionMode: 'STRIPE', currency: 'USD',
  anniversarySeats: true, usageCurrency: 'USD', usagePaymentMode: 'PREPAID', monthlyChargeBasis: 'PER_SEAT', monthlyAmountMinor: 399n };
function fixture(source = 'SERVICE_DEFAULT', current: object | null = regular, currency: string | null = null) {
  const reader = {
    billingService: { findUnique: vi.fn().mockResolvedValue({ tariffHistoryFromMonth: '2026-01' }) },
    billingOrganisationContractVersion: { findMany: vi.fn().mockResolvedValue([]) },
    billingTariffTermEvent: { findFirst: vi.fn().mockImplementation(async ({ where }) =>
      where.source === source ? { tariffId: 'old', tariff: { ...historical, serviceId: 'svc' }, assignmentId: null } : null) },
    billingTariff: { findFirst: vi.fn().mockResolvedValue(current) },
    billingOrganisationRegion: { findUnique: vi.fn().mockResolvedValue(currency ? { currency } : null) },
  };
  return reader;
}

describe('prospective Nessie purchase terms', () => {
  it('uses the published regular default for existing organisations without rewriting monthly history', async () => {
    const reader = fixture();
    expect((await resolveCurrentBillingTariff(reader as never, scope, 'nessie')).tariff.id).toBe('regular');
    expect((await resolveBillingTariffForMonth(reader as never, scope)).tariff.id).toBe('old');
  });
  it.each(['TEAM', 'ORGANISATION'])('preserves an explicit %s agreement', async source => {
    const reader = fixture(source);
    expect((await resolveCurrentBillingTariff(reader as never, scope, 'nessie')).tariff.id).toBe('old');
    expect(reader.billingTariff.findFirst).not.toHaveBeenCalled();
  });
  it.each([null, historical, { ...regular, usagePaymentMode: 'PAY_AS_YOU_GO' },
    { ...regular, monthlyAmountMinor: 0n }])('refuses a missing or uncollected default', async current => {
    await expect(resolveCurrentBillingTariff(fixture('SERVICE_DEFAULT', current) as never, scope, 'nessie'))
      .rejects.toThrow('NESSIE_PREPAID_SETUP_REQUIRED');
  });
  it('selects approved regional seat terms while usage remains USD', async () => {
    const reader = fixture('SERVICE_DEFAULT', regular, 'EUR');
    reader.billingTariff.findFirst.mockResolvedValueOnce(regular).mockResolvedValueOnce({ ...regular, id: 'eur', currency: 'EUR' });
    expect((await resolveCurrentBillingTariff(reader as never, scope, 'nessie')).tariff)
      .toMatchObject({ id: 'eur', currency: 'EUR', usageCurrency: 'USD' });
    expect(reader.billingTariff.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({
      serviceId: 'svc', currency: 'EUR', anniversarySeats: true, usageCurrency: 'USD', usagePaymentMode: 'PREPAID', anniversarySeats: true,
    }) }));
  });
  it('does not change another product', async () => {
    const reader = fixture();
    expect((await resolveCurrentBillingTariff(reader as never, scope, 'deepwater')).tariff.id).toBe('old');
    expect(reader.billingTariff.findFirst).not.toHaveBeenCalled();
  });
});
