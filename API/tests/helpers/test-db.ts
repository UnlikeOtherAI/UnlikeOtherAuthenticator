import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';

type TestDbHandle = {
  prisma: PrismaClient;
  schema: string;
  databaseUrl: string;
  cleanup: () => Promise<void>;
};

function apiRootDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../..');
}

function prismaBinPath(): string {
  const bin = process.platform === 'win32' ? 'prisma.cmd' : 'prisma';
  // In npm teams, binaries are often hoisted to the repo root `node_modules/.bin`.
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
  execFileSync(prismaBinPath(), args, {
    cwd: apiRootDir(),
    env,
    stdio: 'ignore',
  });
}

/**
 * `prisma migrate deploy` serializes on a database-wide advisory lock and each
 * invocation opens fresh connections. When Vitest starts many DB-backed files
 * at once, provisioning can time out on the lock or exhaust connection slots,
 * so retry with backoff instead of failing the whole file on startup
 * contention.
 */
async function withStartupRetry(run: () => void): Promise<void> {
  const maxAttempts = 6;
  for (let attempt = 1; ; attempt += 1) {
    try {
      run();
      return;
    } catch (error) {
      if (attempt >= maxAttempts) throw error;
      const backoffMs = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

/**
 * A test database whose runtime connection is the PRODUCTION RLS role.
 *
 * `createTestDb` connects as the Postgres superuser, which bypasses row-level
 * security entirely — so a suite built on it proves nothing about the policies
 * in `20260423000001_rls_enable_policies`. Several `/org/*` behaviours only
 * exist under RLS (a tenant-scoped read returning zero rows, a sibling-org
 * uniqueness check that cannot see its siblings), and they are invisible to a
 * superuser-backed test.
 *
 * `appDatabaseUrl` connects as `uoa_app` — the same NOLOGIN-in-production,
 * non-BYPASSRLS role the API runs as — so every policy is enforced.
 * `adminDatabaseUrl` connects as `uoa_admin` (BYPASSRLS), matching
 * `DATABASE_ADMIN_URL` in production: domain-hash auth, the config verifier and
 * audit writes run there.
 */
export type RlsTestDbHandle = TestDbHandle & {
  /** Connect as `uoa_app` — RLS fully enforced. Set `DATABASE_URL` to this. */
  appDatabaseUrl: string;
  /** Connect as `uoa_admin` — BYPASSRLS. Set `DATABASE_ADMIN_URL` to this. */
  adminDatabaseUrl: string;
};

const RLS_TEST_ROLE_PASSWORD = 'rls-test-role-password';

function withCredentials(databaseUrl: string, user: string, password: string): string {
  const u = new URL(databaseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

/**
 * Provision a test database and hand back connection strings for the two
 * production database roles.
 *
 * The RLS migration creates `uoa_app`/`uoa_admin` as NOLOGIN (they are reached
 * through a connection pooler in production), so this grants them LOGIN and the
 * schema-local privileges the migration's hardcoded `IN SCHEMA public` grants
 * cannot reach when Prisma applies migrations into an isolated test schema.
 * Role attributes — crucially `uoa_app` having neither SUPERUSER nor BYPASSRLS —
 * are the migration's own and are deliberately left untouched.
 */
export async function createRlsTestDb(): Promise<RlsTestDbHandle | null> {
  const handle = await createTestDb();
  if (!handle) return null;

  const schema = handle.schema;
  // Table/sequence grants are applied per-schema: the migration's GRANTs run
  // with `search_path` narrowed to this schema for the tables that existed at
  // that point, but `ALTER DEFAULT PRIVILEGES IN SCHEMA public` cannot cover
  // tables added by later migrations here. Granting the full DML set to
  // `uoa_app` is deliberately no narrower than production — RLS policies, not
  // grants, are what these suites exercise.
  const statements = [
    `ALTER ROLE uoa_app WITH LOGIN PASSWORD '${RLS_TEST_ROLE_PASSWORD}'`,
    `ALTER ROLE uoa_admin WITH LOGIN PASSWORD '${RLS_TEST_ROLE_PASSWORD}'`,
    `GRANT USAGE ON SCHEMA "${schema}" TO uoa_app, uoa_admin`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO uoa_app, uoa_admin`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO uoa_app, uoa_admin`,
  ];
  for (const statement of statements) {
    await handle.prisma.$executeRawUnsafe(statement);
  }

  return {
    ...handle,
    appDatabaseUrl: withCredentials(handle.databaseUrl, 'uoa_app', RLS_TEST_ROLE_PASSWORD),
    adminDatabaseUrl: withCredentials(handle.databaseUrl, 'uoa_admin', RLS_TEST_ROLE_PASSWORD),
  };
}

export async function createTestDb(): Promise<TestDbHandle | null> {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) return null;

  const schema = `test_${Date.now()}_${randomUUID().replace(/-/g, '')}`;
  const adminUrl = withSchemaParam(baseUrl, 'public');
  const testUrl = withSchemaParam(baseUrl, schema);

  // Prisma narrows search_path to the isolated schema. `citext` is a database-wide extension
  // installed in public, so expose a schema-local domain backed by public.citext before applying
  // migrations. The advisory lock makes first-time extension setup safe when Vitest starts many
  // DB-backed files concurrently.
  await withStartupRetry(() =>
    execFileSync(
      process.platform === 'win32' ? 'cmd' : 'bash',
      process.platform === 'win32'
        ? [
            '/c',
            `echo SELECT pg_advisory_lock(847291); CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public; CREATE SCHEMA IF NOT EXISTS "${schema}"; DROP DOMAIN IF EXISTS "${schema}".citext; CREATE DOMAIN "${schema}".citext AS public.citext; SELECT pg_advisory_unlock(847291); | "${prismaBinPath()}" db execute --stdin --schema prisma/schema.prisma`,
          ]
        : [
            '-lc',
            `echo 'SELECT pg_advisory_lock(847291); CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public; CREATE SCHEMA IF NOT EXISTS "${schema}"; DROP DOMAIN IF EXISTS "${schema}".citext; CREATE DOMAIN "${schema}".citext AS public.citext; SELECT pg_advisory_unlock(847291);' | "${prismaBinPath()}" db execute --stdin --schema prisma/schema.prisma`,
          ],
      {
        cwd: apiRootDir(),
        env: { ...process.env, DATABASE_URL: adminUrl },
        stdio: 'ignore',
      },
    ),
  );

  // Apply migrations into the isolated schema.
  await withStartupRetry(() =>
    runPrisma(['migrate', 'deploy'], { ...process.env, DATABASE_URL: testUrl }),
  );

  const prisma = new PrismaClient({
    datasources: { db: { url: testUrl } },
  });
  await prisma.$connect();

  const cleanup = async (): Promise<void> => {
    await prisma.$disconnect();
    execFileSync(
      process.platform === 'win32' ? 'cmd' : 'bash',
      process.platform === 'win32'
        ? [
            '/c',
            `echo DROP SCHEMA IF EXISTS "${schema}" CASCADE; | "${prismaBinPath()}" db execute --stdin --schema prisma/schema.prisma`,
          ]
        : [
            '-lc',
            `echo 'DROP SCHEMA IF EXISTS "${schema}" CASCADE;' | "${prismaBinPath()}" db execute --stdin --schema prisma/schema.prisma`,
          ],
      {
        cwd: apiRootDir(),
        env: { ...process.env, DATABASE_URL: adminUrl },
        stdio: 'ignore',
      },
    );
  };

  return { prisma, schema, databaseUrl: testUrl, cleanup };
}
