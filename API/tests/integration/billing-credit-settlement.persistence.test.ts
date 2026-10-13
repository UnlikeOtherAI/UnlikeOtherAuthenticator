import { Prisma } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { settleCreditPortfolio } from '../../src/services/billing-credit-settlement.service.js';
import { databaseTestsEnabled, deepwaterCredential, handle, ids, line, nessieCredential, portfolio, settleConcurrently, setupCreditSettlementFixture } from '../helpers/credit-settlement-fixture.js';
import { registerAcceptedStripeFundingCase, registerOrganisationPayerTeamsCase } from './billing-credit-settlement-funding.cases.js';

describe.skipIf(!databaseTestsEnabled)('credit settlement persistence', () => {
  setupCreditSettlementFixture();

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
    expect(attempts).toEqual([1, 2, 2, 2]);

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

  registerAcceptedStripeFundingCase();

  registerOrganisationPayerTeamsCase();

  it('attributes delayed paid usage to the original user after membership becomes inactive', async () => {
    if (!handle) throw new Error('db handle missing');
    await handle.prisma.teamMember.update({
      where: { teamId_userId: { teamId: 'team_credit_settlement_other', userId: ids.second } },
      data: { status: 'DEACTIVATED', statusChangedAt: new Date('2026-09-15T00:00:00.000Z') },
    });
    const delayed = portfolio('mup_departed_user_1234567890123456789012',
      '2026-09-20T12:00:00.000Z', [line('deepwater', ids.second, '0.2')]);
    delayed.scope = {
      ...delayed.scope,
      teamId: 'team_credit_settlement_other',
      month: '2026-09',
      startsAt: '2026-09-01T00:00:00.000Z',
      endsAt: '2026-10-01T00:00:00.000Z',
    };
    await settleCreditPortfolio({
      creditAccountId: 'bca_credit_settlement_org',
      portfolio: delayed,
      credential: deepwaterCredential,
    }, { prisma: handle.prisma });
    const allocation = await handle.prisma.billingCreditUsageAllocation.findFirstOrThrow({
      where: { attributedUserId: ids.second, settlement: { billingMonth: '2026-09' } },
    });
    expect(allocation.cumulativeCreditsConsumedMicrocredits).toBe(260_000_000n);
  });

  it('upgrades populated legacy history without altering totals and restores identity protection', async () => {
    if (!handle) throw new Error('db handle missing');
    const prisma = handle.prisma;
    const before = await prisma.billingCreditUsageSettlement.findMany({
      select: { id: true, creditAccountId: true, teamId: true, billingMonth: true,
        cumulativeCreditsConsumedMicrocredits: true,
        cumulativeRatedUsageAmountMicroMinor: true },
      orderBy: { id: 'asc' },
    });
    const orgRows = before.filter((row) =>
      row.creditAccountId === 'bca_credit_settlement_org' && row.billingMonth === '2026-07');
    expect(orgRows).toHaveLength(2);
    const retained = orgRows[0];
    const removed = orgRows[1];
    if (!retained || !removed) throw new Error('org fixture incomplete');
    // Model a historical overwritten organisation row with adjustments from
    // two source teams. This schema is disposable and isolated to this test.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`
        UPDATE "billing_credit_usage_settlement_adjustments"
        SET "settlement_id" = ${retained.id}, "sequence" = 2
        WHERE "settlement_id" = ${removed.id}
      `);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "billing_credit_usage_allocations"
        SET "settlement_id" = ${retained.id}
        WHERE "settlement_id" = ${removed.id}
      `);
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM "billing_credit_usage_settlements" WHERE "id" = ${removed.id}
      `);
    });
    const financialBefore = await prisma.billingCreditUsageSettlement.findMany({
      select: { id: true, creditAccountId: true, cumulativeCreditsConsumedMicrocredits: true,
        cumulativeRatedUsageAmountMicroMinor: true }, orderBy: { id: 'asc' },
    });
    for (const sql of [
      'DROP INDEX "billing_credit_settlement_team_service_month_key"',
      'DROP INDEX "billing_credit_portfolio_snapshot_team_ledger_id_key"',
      'DROP INDEX "billing_credit_portfolio_snapshot_team_cursor_key"',
      'ALTER TABLE "billing_credit_usage_settlements" DROP CONSTRAINT "billing_credit_usage_settlements_team_id_fkey"',
      'ALTER TABLE "billing_credit_usage_settlements" DROP COLUMN "team_id"',
      'CREATE UNIQUE INDEX "billing_credit_usage_settlements_credit_account_id_service__key" ON "billing_credit_usage_settlements"("credit_account_id", "service_id", "billing_month")',
      'CREATE UNIQUE INDEX "billing_credit_portfolio_snapshot_ledger_id_key" ON "billing_credit_portfolio_snapshots"("credit_account_id", "ledger_snapshot_id")',
      'CREATE UNIQUE INDEX "billing_credit_portfolio_snapshot_cursor_key" ON "billing_credit_portfolio_snapshots"("credit_account_id", "ledger_snapshot_cursor")',
    ]) await prisma.$executeRawUnsafe(sql);
    const migration = path.resolve(process.cwd(),
      'prisma/migrations/20261004120000_scope_credit_settlements_by_origin_team/migration.sql');
    const migrationSource = readFileSync(migration, 'utf8');
    const failingSource = migrationSource.replace(
      'ALTER TABLE "billing_credit_usage_settlements"\n  ENABLE TRIGGER',
      'DO $$ BEGIN RAISE EXCEPTION \'forced upgrade rollback proof\'; END $$;\n' +
        'ALTER TABLE "billing_credit_usage_settlements"\n  ENABLE TRIGGER',
    );
    expect(failingSource).not.toBe(migrationSource);
    expect(() => execFileSync(process.execPath, [
      createRequire(import.meta.url).resolve('prisma/build/index.js'),
      'db', 'execute', '--stdin', '--schema', 'prisma/schema.prisma',
    ], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: handle.databaseUrl },
      input: failingSource, stdio: ['pipe', 'pipe', 'pipe'],
    })).toThrow();
    const trigger = await prisma.$queryRaw<Array<{ tgenabled: string }>>(Prisma.sql`
      SELECT tgenabled FROM pg_trigger
      WHERE tgrelid = 'billing_credit_usage_settlements'::regclass
        AND tgname = 'billing_credit_usage_settlements_immutable_identity'
    `);
    expect(trigger).toEqual([{ tgenabled: 'O' }]);
    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "billing_credit_usage_settlements"
      SET "billing_month" = '2026-08' WHERE "id" = ${retained.id}
    `)).rejects.toThrow();
    execFileSync(process.execPath, [
      createRequire(import.meta.url).resolve('prisma/build/index.js'),
      'db', 'execute', '--file', migration, '--schema', 'prisma/schema.prisma',
    ], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: handle.databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const after = await prisma.billingCreditUsageSettlement.findMany({
      select: { id: true, creditAccountId: true, teamId: true, cumulativeCreditsConsumedMicrocredits: true,
        cumulativeRatedUsageAmountMicroMinor: true }, orderBy: { id: 'asc' },
    });
    expect(after.map(({ teamId: _teamId, ...row }) => row)).toEqual(financialBefore);
    expect(after.find((row) => row.id === retained.id)?.teamId).toBeNull();
    expect(after.filter((row) => row.creditAccountId === ids.creditAccount)
      .every((row) => row.teamId === ids.team)).toBe(true);
    const teamRow = after.find((row) => row.teamId === ids.team);
    if (!teamRow) throw new Error('team lineage missing');
    await expect(prisma.billingCreditUsageSettlement.update({
      where: { id: teamRow.id },
      data: { teamId: 'team_credit_settlement_other' },
    })).rejects.toThrow();
  }, 30_000);
});
