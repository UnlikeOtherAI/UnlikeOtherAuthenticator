import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { meteringWithAssignmentTerms } from '../../src/services/billing-assignment-metering.service.js';
import { assignmentCreditRating } from '../../src/services/billing-assignment-credit-rating.service.js';
import { rateBillingStatementUsage } from '../../src/services/billing-statement-rating.service.js';

const cutoff = new Date('2026-11-25T10:20:30.456Z');
const start = '2026-11-01T00:00:00.000Z';
const end = '2026-12-01T00:00:00.000Z';
const service = { id: 'svc', identifier: 'nessie' };
const line = { billingProduct: 'nessie', userId: 'tester', serviceId: 'provider',
  usageUnit: 'tokens', selectedProviderCost: '10', billingDisposition: 'paid', currency: 'USD' };
const usage = { product: 'nessie', groupBy: 'user', scope: { teamId: 'team', organizationId: 'org',
  month: '2026-11', startsAt: start, endsAt: end }, lines: [line],
  billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
  snapshot: { capturedAt: '2026-11-26T00:00:00.000Z' } };
const events = { findMany: vi.fn(async () => [{ createdAt: cutoff }]),
  findFirst: vi.fn(async ({ where }) => {
    const free = where.OR[1].createdAt.lte >= cutoff;
    return { tariffId: free ? 'free' : 'paid', tariff: { serviceId: 'svc', id: free ? 'free' : 'paid',
      mode: free ? 'FREE' : 'STANDARD', markupBps: free ? 0 : 3000 } };
  }) };
const history = { billingTariffTermEvent: events,
  billingService: { findUnique: async () => ({ tariffHistoryFromMonth: '2026-01' }) },
  billingOrganisationContractVersion: { findMany: async () => [] } };
describe('Admin tariff effective instant', () => {
  it('charges earlier usage once and gives the later usage the Free rate', async () => {
    const fetchUsage = vi.fn(async ({ period }) => ({ ...usage,
      lines: [{ ...line, selectedProviderCost: period.startsAt === start ? '4' : '6' }] }));
    const metering = await meteringWithAssignmentTerms(history as never, 'svc', usage as never, fetchUsage as never);
    expect(fetchUsage.mock.calls.map(([request]) => request.period)).toEqual([
      { startsAt: start, endsAt: cutoff.toISOString() }, { startsAt: cutoff.toISOString(), endsAt: end },
    ]);
    const rated = rateBillingStatementUsage({ userMetering: metering, serviceMetering: metering,
      plan: { product: 'nessie', mode: 'free', markupBps: 0 }, users: [] });
    expect(rated.usage.lines.map(row => row.customer_charge?.amount)).toEqual(['5.2', '0']);
    expect(rated.usage.charge_totals[0]?.usage_charge.amount).toBe('5.2');
  });

  it('leaves an explicit team price in place when its organisation changes tariff', async () => {
    const fixed = { tariffId: 'team', tariff: { id: 'team', serviceId: 'svc' } };
    const db = { ...history, billingTariffTermEvent: { ...events, findFirst: vi.fn().mockResolvedValue(fixed) } };
    const fetchUsage = vi.fn();
    expect(await meteringWithAssignmentTerms(db as never, 'svc', usage as never, fetchUsage))
      .toBe(usage);
    expect(fetchUsage).not.toHaveBeenCalled();
    expect(await assignmentCreditRating(db as never, service, usage as never)).toBeNull();
  });

  it('replays an immutable credit snapshot using only allocations through its adjustment', async () => {
    const groupBy = vi.fn().mockResolvedValue([{ attributedUserId: 'tester',
      _sum: { deltaRatedUsageAmountMicroMinor: 520000000n } }]);
    const db = { ...history, billingCreditUsageAllocation: { groupBy },
      billingCreditUsageSettlementAdjustment: { findFirst: vi.fn().mockResolvedValue({
        sequence: 2, settlementId: 'settlement', settlement: { tariffId: 'paid' },
      }) } };
    const replay = await assignmentCreditRating(db as never, service, { ...usage,
      snapshot: { capturedAt: start } } as never, 'saved-snapshot');
    expect(replay?.amounts.get('tester')).toBe(520000000n);
    expect(groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: { settlementId: 'settlement', adjustment: { sequence: { lte: 2 } } },
    }));
  });

  it('uses frozen charges for credit allocation and excludes prepaid usage already debited', async () => {
    const group = (cost: string, quanta: string, paymentMode: string, tariffId: string) => ({
      userId: 'tester', paymentMode, currency: 'USD', tariffId,
      _sum: { rawCostActual: new Prisma.Decimal(cost), ratedQuanta: new Prisma.Decimal(quanta) },
    });
    const db = { ...history, billingPaidUsageLiability: { groupBy: async () => [
      group('4', '52000000000000000000000', 'PAY_AS_YOU_GO', 'paid'),
      group('4', '0', 'PAY_AS_YOU_GO', 'free'),
    ] }, billingPrepaidReservation: { groupBy: async () => [
      { userId: 'tester', currency: 'USD', _sum: { rawCostActual: new Prisma.Decimal('2') } },
    ] } };
    const rating = await assignmentCreditRating(db as never, service, usage as never);
    expect(rating?.amounts.get('tester')).toBe(520000000n);
    await expect(assignmentCreditRating(db as never, service, { ...usage,
      lines: [{ ...line, selectedProviderCost: '11' }] } as never)).rejects.toThrow('BILLING_CYCLE_METERING_RECEIPT_COST_MISMATCH');
  });
});
