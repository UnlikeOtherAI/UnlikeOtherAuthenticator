import { BillingAssignmentScope } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { runCreditSettlementCycle } from '../../src/services/billing-credit-settlement-scheduler.service.js';

describe('durable credit settlement catch-up', () => {
  it('seeds and revisits past months without a customer credits read', async () => {
    const months: string[] = [];
    const now = new Date('2026-10-05T12:00:00.000Z');
    const account = {
      id: 'credit_1', orgId: 'org_1', teamId: 'team_1',
      scope: BillingAssignmentScope.TEAM,
      createdAt: new Date('2026-08-10T00:00:00.000Z'),
    };
    const watch = {
      id: 'watch_sep', creditAccountId: account.id, teamId: 'team_1',
      billingMonth: '2026-09', creditAccount: account, team: { id: 'team_1' },
    };
    const prisma = {
      billingCreditAccount: { findMany: vi.fn().mockResolvedValue([account]) },
      team: { findMany: vi.fn().mockResolvedValue([
        { id: 'team_1', createdAt: new Date('2026-07-01T00:00:00.000Z') },
      ]) },
      billingOrgResponsibility: { findUnique: vi.fn().mockResolvedValue(null) },
      billingCreditSettlementWatch: {
        createMany: vi.fn().mockImplementation(async ({ data }: { data: Array<{ billingMonth: string }> }) => {
          months.push(...data.map((row) => row.billingMonth));
          return { count: data.length };
        }),
        findMany: vi.fn().mockResolvedValueOnce([watch]).mockResolvedValueOnce([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
      },
      billingCreditPortfolioSnapshot: { findFirst: vi.fn().mockResolvedValue(null) },
      billingService: { findMany: vi.fn().mockResolvedValue([{ identifier: 'deepwater' }]) },
      billingAppKey: { findFirst: vi.fn().mockResolvedValue({
        id: 'key_1', purpose: 'CUSTOMER_LIFECYCLE', actorIssuer: 'issuer',
        actorAudience: 'audience', actorKeyId: 'kid', actorPublicJwk: {},
        checkoutReturnOrigins: [], service: { id: 'service_1', identifier: 'deepwater', name: 'DeepWater' },
      }) },
    };
    const fetchPortfolio = vi.fn().mockResolvedValue({ snapshot: { cursor: 'late_sep_receipt' } });
    const settlePortfolio = vi.fn();
    const result = await runCreditSettlementCycle({
      prisma: prisma as never, now: () => now,
      fetchPortfolio: fetchPortfolio as never,
      settlePortfolio: settlePortfolio as never,
    });
    expect(months).toEqual(['2026-07', '2026-08', '2026-09', '2026-10']);
    expect(fetchPortfolio).toHaveBeenCalledWith(expect.objectContaining({ billingMonth: '2026-09' }));
    expect(settlePortfolio).toHaveBeenCalledTimes(1);
    expect(prisma.billingCreditSettlementWatch.update).toHaveBeenCalledWith({
      where: { id: watch.id },
      data: {
        lastCheckedAt: now,
        nextCheckAt: new Date('2026-10-05T12:05:00.000Z'),
        lastCursor: 'late_sep_receipt',
        lastError: null,
      },
    });
    expect(result).toEqual({ seeded: 4, checked: 1, settled: 1, held: 0, backlog: 0 });
  });

  it('leases one persisted watch across two workers and revisits it after restart', async () => {
    const account = {
      id: 'credit_shared', orgId: 'org_shared', teamId: 'team_shared',
      scope: BillingAssignmentScope.TEAM,
    };
    const watch = {
      id: 'watch_old', creditAccountId: account.id, teamId: 'team_shared',
      billingMonth: '2026-08', nextCheckAt: new Date('2026-10-01T00:00:00.000Z'),
      creditAccount: account, team: { id: 'team_shared' },
    };
    const key = {
      id: 'key_1', purpose: 'CUSTOMER_LIFECYCLE', actorIssuer: 'issuer',
      actorAudience: 'audience', actorKeyId: 'kid', actorPublicJwk: {},
      checkoutReturnOrigins: [], service: { id: 'service_1', identifier: 'deepwater', name: 'DeepWater' },
    };
    const prisma = {
      billingOrgResponsibility: { findUnique: vi.fn().mockResolvedValue(null) },
      billingCreditSettlementWatch: {
        findMany: vi.fn().mockImplementation(async ({ where }: { where: { nextCheckAt: { lte: Date }; billingMonth: { in?: string[]; notIn?: string[] } } }) => {
          const monthAllowed = where.billingMonth.in?.includes(watch.billingMonth) ??
            !where.billingMonth.notIn?.includes(watch.billingMonth);
          return monthAllowed && watch.nextCheckAt <= where.nextCheckAt.lte ? [watch] : [];
        }),
        updateMany: vi.fn().mockImplementation(async ({ where, data }: { where: { nextCheckAt: { lte: Date } }; data: { nextCheckAt: Date } }) => {
          if (watch.nextCheckAt > where.nextCheckAt.lte) return { count: 0 };
          watch.nextCheckAt = data.nextCheckAt;
          return { count: 1 };
        }),
        update: vi.fn().mockImplementation(async ({ data }: { data: { nextCheckAt: Date } }) => {
          watch.nextCheckAt = data.nextCheckAt;
        }),
        count: vi.fn().mockResolvedValue(0),
      },
      billingCreditPortfolioSnapshot: { findFirst: vi.fn().mockResolvedValue(null) },
      billingService: { findMany: vi.fn().mockResolvedValue([{ identifier: 'deepwater' }]) },
      billingAppKey: { findFirst: vi.fn().mockResolvedValue(key) },
    };
    const fetchPortfolio = vi.fn().mockResolvedValue({ snapshot: { cursor: 'late_receipt' } });
    const settlePortfolio = vi.fn();
    const options = {
      prisma: prisma as never, seed: false,
      now: () => new Date('2026-10-05T12:00:00.000Z'),
      fetchPortfolio: fetchPortfolio as never, settlePortfolio: settlePortfolio as never,
    };
    const [first, second] = await Promise.all([
      runCreditSettlementCycle(options), runCreditSettlementCycle(options),
    ]);
    expect(first.checked + second.checked).toBe(1);
    expect(settlePortfolio).toHaveBeenCalledTimes(1);
    const restarted = await runCreditSettlementCycle({
      ...options, now: () => new Date('2026-10-05T13:00:00.000Z'),
    });
    expect(restarted.checked).toBe(1);
    expect(settlePortfolio).toHaveBeenCalledTimes(2);
  });
});
