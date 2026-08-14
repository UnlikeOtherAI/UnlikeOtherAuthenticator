import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../prisma/migrations/20260814130000_team_invite_delivery_foundation/migration.sql',
  import.meta.url,
);

describe('team invite delivery foundation migration (A2.1a)', () => {
  it('opens with bounded lock/statement timeouts before touching any table', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(
      sql
        .trimStart()
        .startsWith(
          "-- Abort fast behind live traffic (Docs/deploy.md): never queue behind a lock.\nSET lock_timeout = '5s';\nSET statement_timeout = '120s';",
        ),
    ).toBe(true);
    expect(sql.indexOf(`SET lock_timeout = '5s';`)).toBeLessThan(sql.indexOf('CREATE TYPE'));
  });

  it('creates the non-secret delivery outbox with enum, lease fields, and indexes', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain(
      `CREATE TYPE "TeamInviteDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT')`,
    );
    expect(sql).toContain('CREATE TABLE "team_invite_deliveries"');
    expect(sql).toContain('"invite_id" TEXT NOT NULL');
    expect(sql).toContain('"generation" INTEGER NOT NULL');
    expect(sql).toContain('"payload" JSONB NOT NULL');
    expect(sql).toContain('"available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP');
    expect(sql).toContain('"claimed_at" TIMESTAMP(3)');
    expect(sql).toContain('"lease_expires_at" TIMESTAMP(3)');
    expect(sql).toContain('"sent_at" TIMESTAMP(3)');
    expect(sql).toContain('"last_error_code" TEXT');
    expect(sql).toContain('CREATE UNIQUE INDEX "team_invite_deliveries_invite_id_generation_key"');
    expect(sql).toContain(`ON "team_invite_deliveries"("invite_id", "generation")`);
    expect(sql).toContain(`ON "team_invite_deliveries"("available_at")\n  WHERE "status" = 'PENDING'`);
    expect(sql).toContain(
      `ON "team_invite_deliveries"("lease_expires_at")\n  WHERE "status" = 'PROCESSING'`,
    );
    expect(sql).toContain('FOREIGN KEY ("invite_id") REFERENCES "team_invites"("id")');
    expect(sql).toContain('ON DELETE CASCADE');
  });

  it('never stores a plaintext or recoverable invite token in the outbox', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    const tableBlock = sql.slice(
      sql.indexOf('CREATE TABLE "team_invite_deliveries"'),
      sql.indexOf('CREATE UNIQUE INDEX'),
    );
    expect(tableBlock.toLowerCase()).not.toContain('token');
    expect(tableBlock.toLowerCase()).not.toContain('secret');
    expect(tableBlock.toLowerCase()).not.toContain('hash');
  });

  it('keeps the outbox admin/BYPASS-only behind forced RLS', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('REVOKE ALL ON TABLE "team_invite_deliveries" FROM "uoa_app"');
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "team_invite_deliveries" TO "uoa_admin"',
    );
    expect(sql).toContain('ALTER TABLE "team_invite_deliveries" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "team_invite_deliveries" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('CREATE POLICY team_invite_deliveries_deny_app');
    expect(sql).toContain('FOR ALL TO uoa_app');
    expect(sql).toContain('USING (false) WITH CHECK (false)');
  });

  it('deterministically revokes duplicate actionable invites before the unique index', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    const dedupe = sql.indexOf('ROW_NUMBER() OVER');
    const unique = sql.indexOf('CREATE UNIQUE INDEX "team_invites_one_actionable_per_team_email"');
    expect(dedupe).toBeGreaterThan(-1);
    expect(unique).toBeGreaterThan(dedupe);
    expect(sql).toContain('PARTITION BY "team_id", lower("email")');
    expect(sql).toContain('ORDER BY "created_at" ASC, "id" ASC');
    // The cleanup predicate and the index predicate are the same four conditions.
    const actionable =
      '"accepted_at" IS NULL\n    AND "declined_at" IS NULL\n    AND "revoked_at" IS NULL\n    AND "approval_status" <> \'DENIED\'';
    expect(sql).toContain(`WHERE ${actionable}`);
    expect(sql).toContain(`WHERE ${actionable.replace(/\n {4}/g, '\n    ')}`);
    expect(sql.match(/"approval_status" <> 'DENIED'/g)?.length).toBe(2);
  });

  it('pins new invite roles to member/admin with a NOT VALID check', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('ADD CONSTRAINT "team_invites_team_role_check"');
    expect(sql).toContain(`CHECK ("team_role" IN ('member', 'admin')) NOT VALID`);
    // Never validated in this migration: accepted historical owner rows survive.
    expect(sql).not.toContain('VALIDATE CONSTRAINT');
  });

  it('adds the three terminal-coherence checks', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('"team_invites_terminal_mutually_exclusive_check"');
    expect(sql).toContain('num_nonnulls("accepted_at", "declined_at", "revoked_at") <= 1');
    expect(sql).toContain('"team_invites_acceptance_pair_check"');
    expect(sql).toContain('"team_invites_accepted_approval_check"');
    expect(sql).toContain(`"approval_status" NOT IN ('PENDING', 'DENIED')`);
  });

  it('is current-schema portable: no hardcoded public schema or PUBLIC revokes on tables', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).not.toMatch(/\bpublic\./);
    expect(sql).not.toContain('public.');
  });
});
