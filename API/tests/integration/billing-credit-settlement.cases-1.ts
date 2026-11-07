import { expect, it } from 'vitest';
import { settleCreditPortfolio } from '../../src/services/billing-credit-settlement.service.js';

import { ids, deepwaterCredential, nessieCredential, line, portfolio, settleConcurrently, handle } from './billing-credit-settlement.suite-fixture.js';

export function registerCases1() {
  it('settles four independent storefront cursors without duplicate debits', async () => {
    if (!handle) throw new Error('db handle missing');
    const cursors = [
      ['mup_cursor_001', '2026-07-21T12:00:00.000Z'],
      ['mup_cursor_001_nessie', '2026-07-21T12:00:01.000Z'],
      ['mup_cursor_001_deepsignal', '2026-07-21T12:00:02.000Z'],
      ['mup_cursor_001_deeptest', '2026-07-21T12:00:03.000Z'],
    ] as const;
    const credentials = [
      deepwaterCredential,
      nessieCredential,
      deepwaterCredential,
      nessieCredential,
    ];

    const { attempts, results } = await settleConcurrently(
      handle.databaseUrl,
      cursors.map((cursor, index) => {
        const storefrontCredential = credentials[index];
        if (!storefrontCredential) throw new Error('concurrency fixture missing');
        return {
          portfolio: portfolio(cursor[0], cursor[1], [
            line('deepwater', ids.owner, '1'),
            line('nessie', null, '1'),
          ]),
          credential: storefrontCredential,
        };
      }),
    );
    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    expect(
      results.every(
        (result) =>
          result.status === 'fulfilled' && !result.value.replayed && !result.value.superseded,
      ),
    ).toBe(true);
    expect(attempts).toEqual([1, 2, 3, 4]);

    const account = await handle.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.creditAccount },
    });
    const settlements = await handle.prisma.billingCreditUsageSettlement.findMany({
      where: { creditAccountId: ids.creditAccount },
      orderBy: { serviceId: 'asc' },
      include: { adjustments: true },
    });
    expect(account.balanceMicrocredits).toBe(0n);
    expect(settlements).toHaveLength(2);
    expect(settlements.every((row) => row.adjustments.length === 4)).toBe(true);
    expect(
      new Set(settlements.flatMap((row) => row.adjustments.map((item) => item.portfolioSnapshotId)))
        .size,
    ).toBe(4);
    expect(await handle.prisma.billingCreditPortfolioSnapshot.count()).toBe(4);
    expect(await handle.prisma.billingCreditEntry.count()).toBe(2);
    expect(settlements.map((row) => row.cumulativeRatedUsageAmountMicroMinor)).toEqual([
      100_000_000n,
      100_000_000n,
    ]);
    expect(settlements.map((row) => row.cumulativeCreditsConsumedMicrocredits)).toEqual([
      375_000_000n,
      375_000_000n,
    ]);
    expect(settlements.map((row) => row.cumulativeRemainingUsageAmountMicroMinor)).toEqual([
      62_500_000n,
      62_500_000n,
    ]);
  }, 30_000);

  it('supersedes older and equal captures that arrive after the newest cursor', async () => {
    if (!handle) throw new Error('db handle missing');
    const cursors = [
      ['mup_cursor_newest_first', '2026-07-21T12:00:07.000Z'],
      ['mup_cursor_older_second', '2026-07-21T12:00:06.000Z'],
      ['mup_cursor_older_third', '2026-07-21T12:00:05.000Z'],
      ['mup_cursor_equal_fourth', '2026-07-21T12:00:07.000Z'],
    ] as const;
    const credentials = [
      deepwaterCredential,
      nessieCredential,
      deepwaterCredential,
      nessieCredential,
    ];
    const beforeSnapshots = await handle.prisma.billingCreditPortfolioSnapshot.count();
    const beforeAdjustments = await handle.prisma.billingCreditUsageSettlementAdjustment.count();

    const { attempts, results } = await settleConcurrently(
      handle.databaseUrl,
      cursors.map((cursor, index) => {
        const storefrontCredential = credentials[index];
        if (!storefrontCredential) throw new Error('concurrency fixture missing');
        return {
          portfolio: portfolio(cursor[0], cursor[1], [
            line('deepwater', ids.owner, index === 0 ? '1' : '9'),
            line('nessie', null, index === 0 ? '1' : '9'),
          ]),
          credential: storefrontCredential,
        };
      }),
    );

    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    const outcomes = results.map((result) => {
      if (result.status !== 'fulfilled') throw result.reason;
      return result.value;
    });
    expect(outcomes.map(({ replayed, superseded }) => ({ replayed, superseded }))).toEqual([
      { replayed: false, superseded: false },
      { replayed: false, superseded: true },
      { replayed: false, superseded: true },
      { replayed: false, superseded: true },
    ]);
    expect(new Set(outcomes.map((outcome) => outcome.snapshotId)).size).toBe(1);
    // Even superseded snapshots serialize the provider-account decision. Each
    // deliberately stale Serializable wave retries after the month fence write.
    expect(attempts).toEqual([1, 2, 3, 4]);

    const replay = await settleCreditPortfolio(
      {
        creditAccountId: ids.creditAccount,
        portfolio: portfolio('mup_cursor_newest_first', '2026-07-21T12:00:07.000Z', [
          line('deepwater', ids.owner, '1'),
          line('nessie', null, '1'),
        ]),
        credential: nessieCredential,
      },
      { prisma: handle.prisma },
    );
    expect(replay).toMatchObject({
      snapshotId: outcomes[0]?.snapshotId,
      replayed: true,
      superseded: false,
    });
    expect(await handle.prisma.billingCreditPortfolioSnapshot.count()).toBe(beforeSnapshots + 1);
    expect(await handle.prisma.billingCreditUsageSettlementAdjustment.count()).toBe(
      beforeAdjustments + 2,
    );
    expect(
      await handle.prisma.billingCreditPortfolioSnapshot.findFirstOrThrow({
        where: { creditAccountId: ids.creditAccount },
        orderBy: [{ capturedAt: 'desc' }, { ledgerSnapshotCursor: 'desc' }],
        select: { ledgerSnapshotCursor: true },
      }),
    ).toEqual({ ledgerSnapshotCursor: 'mup_cursor_newest_first' });
    const settlements = await handle.prisma.billingCreditUsageSettlement.findMany({
      where: { creditAccountId: ids.creditAccount },
      orderBy: { serviceId: 'asc' },
    });
    expect(settlements.map((row) => row.cumulativeRatedUsageAmountMicroMinor)).toEqual([
      100_000_000n,
      100_000_000n,
    ]);
  }, 30_000);

  it('replays the same cursor across storefront keys without another debit', async () => {
    if (!handle) throw new Error('db handle missing');
    const replay = await settleCreditPortfolio(
      {
        creditAccountId: ids.creditAccount,
        portfolio: portfolio('mup_cursor_001', '2026-07-21T12:00:00.000Z', [
          line('deepwater', ids.owner, '1'),
          line('nessie', null, '1'),
        ]),
        credential: nessieCredential,
      },
      { prisma: handle.prisma },
    );

    expect(replay.replayed).toBe(true);
    expect(replay.superseded).toBe(false);
    expect(await handle.prisma.billingCreditEntry.count()).toBe(2);
    expect(await handle.prisma.billingCreditUsageSettlementAdjustment.count()).toBe(10);
  });

  it('rejects changed evidence for an already pinned cursor', async () => {
    if (!handle) throw new Error('db handle missing');
    const snapshotCount = await handle.prisma.billingCreditPortfolioSnapshot.count();

    await expect(
      settleCreditPortfolio(
        {
          creditAccountId: ids.creditAccount,
          portfolio: portfolio(
            'mup_cursor_001',
            '2026-07-21T12:00:00.000Z',
            [line('deepwater', ids.owner, '1'), line('nessie', null, '1')],
            'b'.repeat(64),
          ),
          credential: deepwaterCredential,
        },
        { prisma: handle.prisma },
      ),
    ).rejects.toThrow('LEDGER_CREDIT_SNAPSHOT_MUTATED');
    expect(await handle.prisma.billingCreditPortfolioSnapshot.count()).toBe(snapshotCount);
  });

  it('refunds a lower snapshot and reallocates user attribution deterministically', async () => {
    if (!handle) throw new Error('db handle missing');
    await settleCreditPortfolio(
      {
        creditAccountId: ids.creditAccount,
        portfolio: portfolio('mup_cursor_002', '2026-07-21T12:01:00.000Z', [
          line('deepwater', ids.second, '0.2'),
          line('nessie', null, '0.2'),
        ]),
        credential: deepwaterCredential,
      },
      { prisma: handle.prisma },
    );

    const account = await handle.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.creditAccount },
    });
    const settlements = await handle.prisma.billingCreditUsageSettlement.findMany({
      where: { creditAccountId: ids.creditAccount },
      orderBy: { serviceId: 'asc' },
    });
    const deepwater = settlements.find((row) => row.serviceId === ids.deepwater);
    const latestSecond = await handle.prisma.billingCreditUsageAllocation.findFirst({
      where: { settlementId: deepwater?.id, attributedUserId: ids.second },
      orderBy: { adjustment: { sequence: 'desc' } },
    });
    expect(account.balanceMicrocredits).toBe(350_000_000n);
    expect(settlements.map((row) => row.cumulativeRatedUsageAmountMicroMinor)).toEqual([
      20_000_000n,
      20_000_000n,
    ]);
    expect(settlements.map((row) => row.cumulativeCreditsConsumedMicrocredits)).toEqual([
      200_000_000n,
      200_000_000n,
    ]);
    expect(latestSecond?.cumulativeCreditsConsumedMicrocredits).toBe(200_000_000n);
  });

  it('rejects an unknown non-null user without persisting a partial snapshot', async () => {
    if (!handle) throw new Error('db handle missing');
    const snapshotCount = await handle.prisma.billingCreditPortfolioSnapshot.count();

    await expect(
      settleCreditPortfolio(
        {
          creditAccountId: ids.creditAccount,
          portfolio: portfolio('mup_cursor_003', '2026-07-21T12:02:00.000Z', [
            line('deepwater', 'user_not_in_team', '1'),
          ]),
          credential: deepwaterCredential,
        },
        { prisma: handle.prisma },
      ),
    ).rejects.toThrow('LEDGER_CREDIT_USER_INVALID');
    expect(await handle.prisma.billingCreditPortfolioSnapshot.count()).toBe(snapshotCount);
    expect(
      (
        await handle.prisma.billingCreditAccount.findUniqueOrThrow({
          where: { id: ids.creditAccount },
        })
      ).balanceMicrocredits,
    ).toBe(350_000_000n);
  });
}
