import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../prisma/migrations/20260814140000_team_invite_contract_alignment/migration.sql',
  import.meta.url,
);

describe('team invite contract alignment migration (A2.1a follow-up)', () => {
  it('opens with bounded lock/statement timeouts before touching any table', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(
      sql
        .trimStart()
        .startsWith(
          "-- Abort fast behind live traffic (Docs/deploy.md): never queue behind a lock.\nSET lock_timeout = '5s';\nSET statement_timeout = '120s';",
        ),
    ).toBe(true);
    expect(sql.indexOf(`SET lock_timeout = '5s';`)).toBeLessThan(sql.indexOf('ALTER TABLE'));
  });

  it('adds the generation database default Prisma always declared', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain(`ALTER TABLE "team_invite_deliveries"`);
    expect(sql).toContain(`ALTER COLUMN "generation" SET DEFAULT 0`);
  });

  it('drops and re-adds the identical NOT VALID role rail around the owner cleanup', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    const drop = sql.indexOf('DROP CONSTRAINT "team_invites_team_role_check"');
    const update = sql.indexOf('UPDATE "team_invites"');
    const reAdd = sql.indexOf(`ADD CONSTRAINT "team_invites_team_role_check"`);
    expect(drop).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(drop);
    expect(reAdd).toBeGreaterThan(update);
    // The re-added rail is exactly the A2.1a invariant, still NOT VALID so
    // accepted historical owner rows are never re-scanned.
    expect(sql).toContain(`CHECK ("team_role" IN ('member', 'admin')) NOT VALID`);
    expect(sql).not.toContain('VALIDATE CONSTRAINT');
  });

  it('revokes legacy actionable owner invites using the current actionable predicate', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain(`UPDATE "team_invites"`);
    expect(sql).toContain(`SET "revoked_at" = CURRENT_TIMESTAMP`);
    expect(sql).toContain(`WHERE "team_role" = 'owner'`);
    const actionable =
      '"accepted_at" IS NULL\n  AND "declined_at" IS NULL\n  AND "revoked_at" IS NULL\n  AND "approval_status" <> \'DENIED\'';
    expect(sql).toContain(actionable);
  });

  it('never touches accepted historical owner rows', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    // The update predicate is exactly the actionable set; no accepted-row write anywhere.
    expect(sql).not.toMatch(/UPDATE "team_invites"[^;]*"accepted_at" IS NOT NULL/s);
    expect(sql).not.toContain(`SET "team_role"`);
  });

  it('is current-schema portable: no hardcoded public schema', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).not.toMatch(/\bpublic\./);
  });

  it('keeps the Prisma schema aligned with the database behaviour', async () => {
    const schema = await readFile(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
    const block = schema.slice(
      schema.indexOf('model TeamInviteDelivery {'),
      schema.indexOf('@@map("team_invite_deliveries")'),
    );
    expect(block).toContain('generation     Int                      @default(0)');
    expect(block).toContain(
      'updatedAt      DateTime                 @default(now()) @updatedAt @map("updated_at")',
    );
  });
});
