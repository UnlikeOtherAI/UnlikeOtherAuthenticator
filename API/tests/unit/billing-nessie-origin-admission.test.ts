import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDispatchFundingTariff } from '../../src/services/billing-nessie-usage-admission.service.js';
import { resolveCurrentBillingTariff } from '../../src/services/billing-current-tariff.service.js';
import { assertNessieSeatUsage } from '../../src/services/billing-nessie-seat-access.service.js';
import { assertLedgerBudgetContext } from '../../src/services/billing-credit-budget-dispatch.service.js';
import type { EffectiveTariff } from '../../src/services/billing-tariff-history.service.js';

vi.mock('../../src/services/billing-current-tariff.service.js', () => ({ resolveCurrentBillingTariff: vi.fn() }));
vi.mock('../../src/services/billing-nessie-seat-access.service.js', () => ({ assertNessieSeatUsage: vi.fn() }));
const scope = { serviceId: 'research', organisationId: 'org', teamId: 'team', userId: 'user', billingMonth: '2026-11' };
const origin = { source: 'SERVICE_DEFAULT', assignmentId: null, tariff: { id: 'nessie-regular',
  mode: 'STANDARD', usagePaymentMode: 'PREPAID', collectionMode: 'STRIPE', monthlyChargeBasis: 'PER_SEAT',
  monthlyAmountMinor: 399n, seatPolicy: 'AUTOMATIC', seatChargeTiming: 'PRORATED' } } as EffectiveTariff;
const child = (usagePaymentMode = 'PREPAID', mode = 'AT_COST', source = 'SERVICE_DEFAULT') =>
  ({ source, assignmentId: null, tariff: { id: 'research-price', mode, usagePaymentMode } }) as EffectiveTariff;
const reader = { billingService: { findUnique: vi.fn().mockResolvedValue({ id: 'nessie-service', active: true }) } };
const resolve = (originProduct?: string) => resolveDispatchFundingTariff(reader as never, scope, 'deepwater', originProduct);
beforeEach(() => { vi.clearAllMocks(); vi.mocked(assertNessieSeatUsage).mockResolvedValue();
  reader.billingService.findUnique.mockResolvedValue({ id: 'nessie-service', active: true }); });

describe('Nessie-origin paid dispatches', () => {
  it.each([child('PAY_AS_YOU_GO'), child('PREPAID', 'FREE')])('rejects unfunded child terms before dispatch: %j', async terms => {
    vi.mocked(resolveCurrentBillingTariff).mockResolvedValue(terms);
    await expect(resolve('nessie')).rejects.toThrow('NESSIE_PREPAID_SETUP_REQUIRED');
  });
  it('preserves child prices while checking the exact original member and Nessie service', async () => {
    vi.mocked(resolveCurrentBillingTariff).mockResolvedValueOnce(child()).mockResolvedValueOnce(origin);
    expect(await resolve('nessie')).toEqual(child().tariff);
    expect(assertNessieSeatUsage).toHaveBeenLastCalledWith(reader, { ...scope, serviceId: 'nessie-service', product: 'nessie' });
  });
  it('refuses an unpaid Nessie seat even when research itself is prepaid', async () => {
    vi.mocked(resolveCurrentBillingTariff).mockResolvedValueOnce(child()).mockResolvedValueOnce(origin);
    vi.mocked(assertNessieSeatUsage).mockResolvedValueOnce().mockRejectedValueOnce(new Error('BILLING_SEAT_PAYMENT_REQUIRED'));
    await expect(resolve('nessie')).rejects.toThrow('BILLING_SEAT_PAYMENT_REQUIRED');
  });
  it('retains explicit research subsidies but still checks the originating seat', async () => {
    vi.mocked(resolveCurrentBillingTariff).mockResolvedValueOnce(child('PAY_AS_YOU_GO', 'FREE', 'ORGANISATION')).mockResolvedValueOnce(origin);
    await expect(resolve('nessie')).resolves.toMatchObject({ mode: 'FREE' });
    expect(assertNessieSeatUsage).toHaveBeenLastCalledWith(reader, expect.objectContaining({ product: 'nessie' }));
  });
  it('fails closed when the originating billing service is disabled', async () => {
    vi.mocked(resolveCurrentBillingTariff).mockResolvedValueOnce(child());
    reader.billingService.findUnique.mockResolvedValue({ id: 'nessie-service', active: false });
    await expect(resolve('nessie')).rejects.toThrow('NESSIE_BILLING_ORIGIN_UNAVAILABLE');
  });
  it('preserves a direct customer of another product', async () => {
    vi.mocked(resolveCurrentBillingTariff).mockResolvedValue(child('PAY_AS_YOU_GO'));
    await expect(resolve()).resolves.toMatchObject({ usagePaymentMode: 'PAY_AS_YOU_GO' });
    expect(reader.billingService.findUnique).not.toHaveBeenCalled();
  });
  it('cannot relabel a Nessie job as direct research or omit its origin', async () => {
    const tx = { billingJobComputeRenewal: { findUnique: vi.fn().mockResolvedValue({ originProduct: 'nessie',
      originSourceDomain: 'nessie.works', originInvocationId: 'invocation' }) } };
    const input = { product: 'deepwater', sourceDomain: 'deepwater.example', jobGrantId: 'grant', originInvocationId: 'invocation' };
    for (const context of [null, { contextId: 'invocation', originProduct: 'deepwater', originSourceDomain: 'deepwater.example',
      projectId: null, runId: null }]) {
      await expect(assertLedgerBudgetContext(tx as never, { ...input, context })).rejects.toThrow('BUDGET_ORIGIN_CONTEXT_MISMATCH');
    }
    await expect(assertLedgerBudgetContext(tx as never, { ...input, context: { contextId: 'invocation', originProduct: 'nessie',
      originSourceDomain: 'nessie.works', projectId: null, runId: null } })).resolves.toBeUndefined();
  });
});
