import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const MIGRATION_NAME = '20260814130000_team_invite_delivery_foundation';

function apiRootDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../..');
}

function prismaBinPath(): string {
  const bin = process.platform === 'win32' ? 'prisma.cmd' : 'prisma';
  const local = path.join(apiRootDir(), 'node_modules', '.bin', bin);
  if (fs.existsSync(local)) return local;
  return path.join(apiRootDir(), '..', 'node_modules', '.bin', bin);
}

function withSchemaParam(databaseUrl: string, schema: string): string {
  const u = new URL(databaseUrl);
  u.searchParams.set('schema', schema);
  return u.toString();
}

function runPrisma(args: string[], env: NodeJS.ProcessEnv): void {
  execFileSync(prismaBinPath(), args, { cwd: apiRootDir(), env, stdio: 'ignore' });
}

function runSql(databaseUrl: string, schemaDir: string, sql: string): void {
  execFileSync(
    prismaBinPath(),
    ['db', 'execute', '--stdin', '--schema', path.join(schemaDir, 'schema.prisma')],
    { cwd: apiRootDir(), env: { ...process.env, DATABASE_URL: databaseUrl }, input: sql },
  );
}

type InviteSeed = {
  id?: string;
  email?: string;
  teamRole?: string;
  approvalStatus?: string;
  acceptedAt?: boolean;
  acceptedUserId?: boolean;
  declinedAt?: boolean;
  revokedAt?: boolean;
};

/**
 * Real-Postgres proof for the A2.1a migration. Deploys the full committed
 * migration history MINUS the migration under test into an isolated
 * non-public schema, seeds pre-migration duplicate/historical invite rows,
 * applies the migration SQL itself, then asserts the catalog state, the data
 * cleanup, and every constraint end-to-end. Skipped explicitly when
 * DATABASE_URL is absent.
 */
describe.skipIf(!hasDatabase)('team invite delivery foundation migration — real Postgres', () => {
  let prisma: PrismaClient;
  let schema: string;
  let tmpDir: string;
  let testUrl: string;
  let migrationSql: string;
  let orgId: string;
  let teamId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    const baseUrl = process.env.DATABASE_URL;
    if (!baseUrl) throw new Error('DATABASE_URL is required for DB-backed tests');

    schema = `test_${Date.now()}_${randomUUID().replace(/-/g, '')}`;
    const adminUrl = withSchemaParam(baseUrl, 'public');
    testUrl = withSchemaParam(baseUrl, schema);

    // Stage a schema dir whose migrations are the full committed history
    // minus the migration under test.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uoa-a21a-'));
    const stagedPrisma = path.join(tmpDir, 'prisma');
    fs.mkdirSync(stagedPrisma);
    fs.copyFileSync(
      path.join(apiRootDir(), 'prisma', 'schema.prisma'),
      path.join(stagedPrisma, 'schema.prisma'),
    );
    const srcMigrations = path.join(apiRootDir(), 'prisma', 'migrations');
    const stagedMigrations = path.join(stagedPrisma, 'migrations');
    fs.mkdirSync(stagedMigrations);
    for (const entry of fs.readdirSync(srcMigrations)) {
      if (entry === MIGRATION_NAME) continue;
      const src = path.join(srcMigrations, entry);
      const dest = path.join(stagedMigrations, entry);
      if (fs.statSync(src).isDirectory()) fs.cpSync(src, dest, { recursive: true });
      else fs.copyFileSync(src, dest);
    }
    migrationSql = fs.readFileSync(
      path.join(srcMigrations, MIGRATION_NAME, 'migration.sql'),
      'utf8',
    );

    // citext lives database-wide in public; expose a schema-local domain like
    // tests/helpers/test-db.ts does before applying migrations.
    runSql(
      adminUrl,
      stagedPrisma,
      `CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
       CREATE SCHEMA "${schema}";
       CREATE DOMAIN "${schema}".citext AS public.citext;`,
    );
    runPrisma(['migrate', 'deploy', '--schema', path.join(stagedPrisma, 'schema.prisma')], {
      ...process.env,
      DATABASE_URL: testUrl,
    });

    prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
    await prisma.$connect();

    // Seed pre-migration rows: org + team owner (FK target for acceptance).
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    orgId = `org_${suffix}`;
    teamId = `team_${suffix}`;
    ownerUserId = `user_${suffix}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "users" ("id", "email", "user_key")
       VALUES ($1, $2, $3)`,
      ownerUserId,
      `owner-${suffix}@example.com`,
      `owner-${suffix}@example.com`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "organisations" ("id", "domain", "name", "slug", "owner_id", "updated_at")
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      orgId,
      `${suffix}.example.com`,
      'Org',
      suffix,
      ownerUserId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "teams" ("id", "org_id", "name", "slug", "updated_at")
       VALUES ($1, $2, 'Team', $3, CURRENT_TIMESTAMP)`,
      teamId,
      orgId,
      suffix,
    );
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (schema && tmpDir) {
      runSql(
        withSchemaParam(process.env.DATABASE_URL as string, 'public'),
        path.join(tmpDir, 'prisma'),
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`,
      );
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  async function insertInvite(overrides: InviteSeed): Promise<string> {
    const id = overrides.id ?? `inv_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const params: unknown[] = [
      id,
      orgId,
      teamId,
      overrides.email ?? 'dup@example.com',
      overrides.teamRole ?? 'member',
      overrides.approvalStatus ?? 'NOT_REQUIRED',
    ];
    const acceptedUserValue = overrides.acceptedUserId ? '$7' : 'NULL';
    if (overrides.acceptedUserId) params.push(ownerUserId);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "team_invites"
         ("id", "org_id", "team_id", "email", "team_role", "approval_status",
          "accepted_at", "accepted_user_id", "declined_at", "revoked_at",
          "last_sent_at", "updated_at")
       VALUES ($1, $2, $3, $4, $5, $6::"InviteApprovalStatus",
          ${overrides.acceptedAt ? 'CURRENT_TIMESTAMP' : 'NULL'},
          ${acceptedUserValue},
          ${overrides.declinedAt ? 'CURRENT_TIMESTAMP' : 'NULL'},
          ${overrides.revokedAt ? 'CURRENT_TIMESTAMP' : 'NULL'},
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ...(params as string[]),
    );
    return id;
  }

  it('revokes duplicate actionable invites deterministically, keeping the oldest', async () => {
    const older = await insertInvite({ id: 'inv_keep_older', email: 'Dup@Example.com' });
    await prisma.$executeRawUnsafe(
      `UPDATE "team_invites" SET "created_at" = CURRENT_TIMESTAMP - INTERVAL '1 day' WHERE "id" = $1`,
      older,
    );
    await insertInvite({ id: 'inv_dup_newer', email: 'dup@example.COM' });
    await insertInvite({ id: 'inv_terminal', email: 'dup@example.com', revokedAt: true });
    await insertInvite({
      id: 'inv_hist_owner',
      email: 'legacy-owner@example.com',
      teamRole: 'owner',
      acceptedAt: true,
      acceptedUserId: true,
    });

    runSql(testUrl, path.join(tmpDir, 'prisma'), migrationSql);

    const rows = await prisma.$queryRawUnsafe<
      Array<{ id: string; revoked_at: Date | null; team_role: string }>
    >(
      `SELECT "id", "revoked_at", "team_role" FROM "team_invites"
        WHERE "id" IN ('inv_keep_older', 'inv_dup_newer', 'inv_terminal', 'inv_hist_owner')
        ORDER BY "id"`,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('inv_keep_older')?.revoked_at).toBeNull();
    expect(byId.get('inv_dup_newer')?.revoked_at).not.toBeNull();
    expect(byId.get('inv_terminal')?.revoked_at).not.toBeNull();
    // Historical accepted owner row untouched by the NOT VALID role check.
    expect(byId.get('inv_hist_owner')?.team_role).toBe('owner');
  });

  it('enforces one actionable invite per team/lower(email) and nothing more', async () => {
    // inv_keep_older (dup@example.com, actionable) exists after migration.
    await expect(insertInvite({ email: 'DUP@example.com' })).rejects.toThrow();
    await expect(
      insertInvite({ email: 'dup@example.com', approvalStatus: 'PENDING' }),
    ).rejects.toThrow();
    // Terminal/DENIED rows for the same email stay insertable.
    await insertInvite({ email: 'dup@example.com', declinedAt: true });
    await insertInvite({ email: 'dup@example.com', approvalStatus: 'DENIED' });
    await insertInvite({ email: 'other@example.com' });
  });

  it('pins new invite roles to member/admin without rewriting history', async () => {
    await expect(insertInvite({ email: 'x1@example.com', teamRole: 'owner' })).rejects.toThrow();
    await insertInvite({ email: 'x2@example.com', teamRole: 'member' });
    await insertInvite({ email: 'x3@example.com', teamRole: 'admin' });
    // NOT VALID is still enforced on UPDATE of the historical owner row.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "team_invites" SET "invite_name" = 'renamed' WHERE "id" = 'inv_hist_owner'`,
      ),
    ).rejects.toThrow();
  });

  it('enforces terminal coherence', async () => {
    await expect(
      insertInvite({
        email: 't1@example.com',
        acceptedAt: true,
        acceptedUserId: true,
        declinedAt: true,
      }),
    ).rejects.toThrow();
    await expect(
      insertInvite({ email: 't2@example.com', acceptedAt: true, acceptedUserId: true, revokedAt: true }),
    ).rejects.toThrow();
    // accepted_at without accepted_user_id violates the pair check.
    await expect(insertInvite({ email: 't3@example.com', acceptedAt: true })).rejects.toThrow();
    // accepted rows cannot stay PENDING.
    await expect(
      insertInvite({
        email: 't4@example.com',
        acceptedAt: true,
        acceptedUserId: true,
        approvalStatus: 'PENDING',
      }),
    ).rejects.toThrow();
    // A coherent accepted row is fine.
    await insertInvite({ email: 't5@example.com', acceptedAt: true, acceptedUserId: true });
  });

  it('creates the outbox with invite relation, generation uniqueness, and partial indexes', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "team_invite_deliveries" ("id", "invite_id", "generation", "payload")
       VALUES ('del_1', 'inv_keep_older', 0, '{"email":"dup@example.com"}'::jsonb)`,
    );
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "team_invite_deliveries" ("id", "invite_id", "generation")
         VALUES ('del_2', 'inv_keep_older', 0)`,
      ),
    ).rejects.toThrow();
    // Next generation is a fresh row.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "team_invite_deliveries" ("id", "invite_id", "generation")
       VALUES ('del_3', 'inv_keep_older', 1)`,
    );

    const indexes = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'team_invite_deliveries'`,
      schema,
    );
    const defs = indexes.map((row) => row.indexdef).join('\n');
    expect(defs).toContain('team_invite_deliveries_pending_idx');
    expect(defs).toContain(`WHERE (status = 'PENDING'::"TeamInviteDeliveryStatus")`);
    expect(defs).toContain('team_invite_deliveries_lease_idx');
    expect(defs).toContain('team_invite_deliveries_invite_id_generation_key');
  });

  it('locks the outbox to the BYPASSRLS admin posture', async () => {
    const flags = await prisma.$queryRawUnsafe<
      Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >(
      `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'team_invite_deliveries' AND n.nspname = $1`,
      schema,
    );
    expect(flags).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

    const policies = await prisma.$queryRawUnsafe<Array<{ policyname: string }>>(
      `SELECT policyname FROM pg_policies
        WHERE schemaname = $1 AND tablename = 'team_invite_deliveries'`,
      schema,
    );
    expect(policies.map((row) => row.policyname)).toContain('team_invite_deliveries_deny_app');

    const grants = await prisma.$queryRawUnsafe<Array<{ app_can: boolean; admin_can: boolean }>>(
      `SELECT has_table_privilege('uoa_app', $1, 'INSERT') AS app_can,
              has_table_privilege('uoa_admin', $1, 'INSERT') AS admin_can`,
      `${schema}.team_invite_deliveries`,
    );
    expect(grants).toEqual([{ app_can: false, admin_can: true }]);
  });

  it('is current-schema portable: objects live in the test schema, never public', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ schema: string; count: bigint }>>(
      `SELECT n.nspname AS schema, COUNT(*) AS count
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname IN ('team_invite_deliveries', 'team_invites_one_actionable_per_team_email')
          AND c.relkind IN ('r', 'i')
          AND n.nspname IN ($1, 'public')
        GROUP BY n.nspname`,
      schema,
    );
    expect(rows).toEqual([{ schema, count: BigInt(2) }]);
  });

  it('stores no token or secret column in the outbox', async () => {
    const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'team_invite_deliveries'`,
      schema,
    );
    const names = columns.map((row) => row.column_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'invite_id',
        'generation',
        'status',
        'payload',
        'attempts',
        'available_at',
        'claimed_at',
        'lease_expires_at',
        'sent_at',
        'last_error_code',
        'created_at',
        'updated_at',
      ]),
    );
    for (const name of names) {
      expect(name).not.toMatch(/token|secret|hash/i);
    }
  });
});
