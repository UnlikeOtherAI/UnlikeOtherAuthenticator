import { Prisma } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it } from 'vitest';

import { ids, handle } from './billing-credit-settlement.suite-fixture.js';

export function registerCases3() {
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
}
