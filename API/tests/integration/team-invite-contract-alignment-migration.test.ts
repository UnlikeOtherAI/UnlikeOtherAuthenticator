import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const FOUNDATION_MIGRATION = '20260814130000_team_invite_delivery_foundation';
const ALIGNMENT_MIGRATION = '20260814140000_team_invite_contract_alignment';

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
  id: string;
  email: string;
  teamRole?: string;
  approvalStatus?: string;
  acceptedAt?: boolean;
  acceptedUserId?: string;
  declinedAt?: boolean;
  revokedAt?: boolean;
};

/**
 * Real-Postgres proof that the A2.1a foundation migration
 * (20260814130000) followed IMMEDIATELY by the contract-alignment migration
 * (20260814140000) forms one contiguous upgrade path. Deploys full committed
 * history MINUS both migrations into an isolated non-public schema, seeds
 * legacy owner invites (actionable + accepted historical), then runs the
 * foundation SQL followed directly by the alignment SQL with no intervening
 * test mutation, and asserts the combined end state. Skipped explicitly when
 * DATABASE_URL is absent.
 */
describe.skipIf(!hasDatabase)(
  'team invite foundation → contract alignment contiguous upgrade — real Postgres',
  () => {
    let prisma: PrismaClient;
    let schema: string;
    let tmpDir: string;
    let testUrl: string;
    let orgId: string;
    let teamId: string;
    let ownerUserId: string;

    async function insertInvite(seed: InviteSeed): Promise<string> {
      const params: unknown[] = [
        seed.id,
        orgId,
        teamId,
        seed.email,
        seed.teamRole ?? 'member',
        seed.approvalStatus ?? 'NOT_REQUIRED',
      ];
      let acceptedUserValue = 'NULL';
      if (seed.acceptedUserId) {
        params.push(seed.acceptedUserId);
        acceptedUserValue = `$${params.length}`;
      }
      await prisma.$executeRawUnsafe(
        `INSERT INTO "team_invites"
           ("id", "org_id", "team_id", "email", "team_role", "approval_status",
            "accepted_at", "accepted_user_id", "declined_at", "revoked_at",
            "last_sent_at", "updated_at")
         VALUES ($1, $2, $3, $4, $5, $6::"InviteApprovalStatus",
            ${seed.acceptedAt ? 'CURRENT_TIMESTAMP' : 'NULL'},
            ${acceptedUserValue},
            ${seed.declinedAt ? 'CURRENT_TIMESTAMP' : 'NULL'},
            ${seed.revokedAt ? 'CURRENT_TIMESTAMP' : 'NULL'},
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        ...(params as string[]),
      );
      return seed.id;
    }

    beforeAll(async () => {
      const baseUrl = process.env.DATABASE_URL;
      if (!baseUrl) throw new Error('DATABASE_URL is required for DB-backed tests');

      schema = `test_${Date.now()}_${randomUUID().replace(/-/g, '')}`;
      const adminUrl = withSchemaParam(baseUrl, 'public');
      testUrl = withSchemaParam(baseUrl, schema);

      // Stage full committed history minus BOTH migrations under test.
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uoa-a21a-pair-'));
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
        if (entry === FOUNDATION_MIGRATION || entry === ALIGNMENT_MIGRATION) continue;
        const src = path.join(srcMigrations, entry);
        const dest = path.join(stagedMigrations, entry);
        if (fs.statSync(src).isDirectory()) fs.cpSync(src, dest, { recursive: true });
        else fs.copyFileSync(src, dest);
      }

      // citext lives database-wide in public; expose a schema-local domain
      // like tests/helpers/test-db.ts does before applying migrations.
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

      // Seed the full pre-migration world: org + team + owner user, then the
      // legacy invites that predate both migrations.
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

      // Legacy owner rows written under the OLD schema (owner allowed):
      // one still actionable, one already accepted (historical fact), and
      // already-resolved denied/declined rows the cleanup must leave alone.
      await insertInvite({
        id: 'inv_legacy_owner_actionable',
        email: 'actionable-owner@example.com',
        teamRole: 'owner',
      });
      await insertInvite({
        id: 'inv_legacy_owner_denied',
        email: 'denied-owner@example.com',
        teamRole: 'owner',
        approvalStatus: 'DENIED',
      });
      await insertInvite({
        id: 'inv_legacy_owner_declined',
        email: 'declined-owner@example.com',
        teamRole: 'owner',
        declinedAt: true,
      });
      await insertInvite({
        id: 'inv_legacy_owner_accepted',
        email: 'accepted-owner@example.com',
        teamRole: 'owner',
        acceptedAt: true,
        acceptedUserId: ownerUserId,
      });
      await insertInvite({
        id: 'inv_member_actionable',
        email: 'member@example.com',
        teamRole: 'member',
      });

      // The contiguous upgrade path: foundation then alignment, no
      // intervening test mutation. These two run back-to-back exactly as a
      // deploy would apply them.
      const srcDir = path.join(apiRootDir(), 'prisma', 'migrations');
      runSql(testUrl, stagedPrisma, fs.readFileSync(path.join(srcDir, FOUNDATION_MIGRATION, 'migration.sql'), 'utf8'));
      runSql(testUrl, stagedPrisma, fs.readFileSync(path.join(srcDir, ALIGNMENT_MIGRATION, 'migration.sql'), 'utf8'));
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

    it('revokes the actionable legacy owner invite after both migrations', async () => {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ team_role: string; revoked_at: Date | null; accepted_at: Date | null }>
      >(
        `SELECT "team_role", "revoked_at", "accepted_at"
           FROM "team_invites" WHERE "id" = 'inv_legacy_owner_actionable'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.team_role).toBe('owner');
      expect(rows[0]?.revoked_at).not.toBeNull();
    });

    it('leaves already-resolved legacy owner rows (denied/declined) un-revoked', async () => {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ id: string; revoked_at: Date | null; declined_at: Date | null }>
      >(
        `SELECT "id", "revoked_at", "declined_at"
           FROM "team_invites"
          WHERE "id" IN ('inv_legacy_owner_denied', 'inv_legacy_owner_declined') ORDER BY "id"`,
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get('inv_legacy_owner_declined')?.declined_at).not.toBeNull();
      expect(byId.get('inv_legacy_owner_declined')?.revoked_at).toBeNull();
      expect(byId.get('inv_legacy_owner_denied')?.revoked_at).toBeNull();
    });

    it('leaves the accepted historical owner row completely untouched', async () => {
      const rows = await prisma.$queryRawUnsafe<
        Array<{
          team_role: string;
          revoked_at: Date | null;
          accepted_at: Date | null;
          accepted_user_id: string | null;
        }>
      >(
        `SELECT "team_role", "revoked_at", "accepted_at", "accepted_user_id"
           FROM "team_invites" WHERE "id" = 'inv_legacy_owner_accepted'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.team_role).toBe('owner');
      expect(rows[0]?.accepted_at).not.toBeNull();
      expect(rows[0]?.accepted_user_id).toBe(ownerUserId);
      expect(rows[0]?.revoked_at).toBeNull();
    });

    it('keeps the actionable member invite actionable', async () => {
      const rows = await prisma.$queryRawUnsafe<Array<{ revoked_at: Date | null }>>(
        `SELECT "revoked_at" FROM "team_invites" WHERE "id" = 'inv_member_actionable'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revoked_at).toBeNull();
    });

    it('gives raw outbox inserts generation 0 and non-null timestamps without specifying them', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "team_invite_deliveries" ("id", "invite_id")
         VALUES ('del_raw_default', 'inv_member_actionable')`,
      );
      const rows = await prisma.$queryRawUnsafe<
        Array<{ generation: number; updated_at: Date | null; created_at: Date | null; status: string }>
      >(
        `SELECT "generation", "updated_at", "created_at", "status"
           FROM "team_invite_deliveries" WHERE "id" = 'del_raw_default'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.generation).toBe(0);
      expect(rows[0]?.updated_at).not.toBeNull();
      expect(rows[0]?.created_at).not.toBeNull();
      expect(rows[0]?.status).toBe('PENDING');
    });

    it('rejects new owner-role invite writes after the contiguous upgrade', async () => {
      await expect(
        insertInvite({ id: 'inv_new_owner', email: 'new-owner@example.com', teamRole: 'owner' }),
      ).rejects.toThrow();
      // member/admin still write fine.
      await insertInvite({ id: 'inv_new_member', email: 'new-member@example.com', teamRole: 'member' });
      await insertInvite({ id: 'inv_new_admin', email: 'new-admin@example.com', teamRole: 'admin' });
    });

    it('keeps the role rail re-checking the accepted owner row on UPDATE', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "team_invites" SET "invite_name" = 'renamed'
             WHERE "id" = 'inv_legacy_owner_accepted'`,
        ),
      ).rejects.toThrow();
    });

    it('proves non-public schema behavior: all new objects live in the test schema, never public', async () => {
      const rows = await prisma.$queryRawUnsafe<Array<{ schema: string; count: bigint }>>(
        `SELECT n.nspname AS schema, COUNT(*) AS count
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname IN (
                  'team_invite_deliveries',
                  'team_invites_one_actionable_per_team_email',
                  'team_invite_deliveries_invite_id_generation_key'
                )
            AND c.relkind IN ('r', 'i')
            AND n.nspname IN ($1, 'public')
          GROUP BY n.nspname`,
        schema,
      );
      expect(rows).toEqual([{ schema, count: BigInt(3) }]);

      const enumRows = await prisma.$queryRawUnsafe<Array<{ schema: string }>>(
        `SELECT n.nspname AS schema
           FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'TeamInviteDeliveryStatus' AND n.nspname IN ($1, 'public')`,
        schema,
      );
      expect(enumRows.map((row) => row.schema)).toEqual([schema]);

      const colDefault = await prisma.$queryRawUnsafe<Array<{ column_default: string | null }>>(
        `SELECT column_default FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'team_invite_deliveries'
            AND column_name = 'generation'`,
        schema,
      );
      expect(colDefault).toHaveLength(1);
      expect(colDefault[0]?.column_default).toBe('0');
    });
  },
);
