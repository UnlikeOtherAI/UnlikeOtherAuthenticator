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
    expect(months).toEqual(['2026-08', '2026-09', '2026-10']);
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
    expect(result).toEqual({ seeded: 3, checked: 1, settled: 1, held: 0, backlog: 0 });
  });
});
