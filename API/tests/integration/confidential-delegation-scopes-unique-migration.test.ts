import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const HELPER = 'confidential_delegation_scopes_unique';

/**
 * Database-level proof for the Phase A1 scopes-uniqueness migration. The
 * unit suite only reads the migration SQL; this suite applies every
 * migration into an isolated schema via createTestDb and asserts on the real
 * catalog state:
 *
 *   1. The helper exists exactly once, in the migration's target schema, and
 *      never in `public`.
 *   2. The mapping scope CHECK depends on that schema's helper specifically.
 *   3. PUBLIC lacks EXECUTE (aclexplode with grantee 0), while the runtime
 *      `uoa_app` role lacks it and `uoa_admin` keeps it.
 */
describe.skipIf(!hasDatabase)('confidential delegation scopes-unique helper — real Postgres', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
  });

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('creates the helper exactly once in the target schema and never in public', async () => {
    if (!handle) throw new Error('db handle missing');

    // Other concurrently provisioned test schemas may legitimately hold their
    // own copy; the assertion is pinned to the schema under test and public.
    const rows = await handle.prisma.$queryRawUnsafe<
      Array<{ schema: string; count: bigint }>
    >(
      `SELECT n.nspname AS schema, COUNT(*) AS count
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = $1
          AND n.nspname IN ($2, 'public')
        GROUP BY n.nspname`,
      HELPER,
      handle.schema,
    );

    expect(rows).toEqual([{ schema: handle.schema, count: BigInt(1) }]);
    expect(rows.some((row) => row.schema === 'public')).toBe(false);
  });

  it('binds the mapping scope CHECK to the helper in the same schema', async () => {
    if (!handle) throw new Error('db handle missing');

    const rows = await handle.prisma.$queryRawUnsafe<
      Array<{ constraint_schema: string; function_schema: string }>
    >(
      `SELECT cn.nspname AS constraint_schema, pn.nspname AS function_schema
         FROM pg_constraint c
         JOIN pg_class rel ON rel.oid = c.conrelid
         JOIN pg_namespace cn ON cn.oid = rel.relnamespace
         JOIN pg_depend dep ON dep.classid = 'pg_constraint'::regclass AND dep.objid = c.oid
         JOIN pg_proc p ON p.oid = dep.refobjid AND dep.refclassid = 'pg_proc'::regclass
         JOIN pg_namespace pn ON pn.oid = p.pronamespace
        WHERE c.conname = 'confidential_delegation_mappings_scopes_check'
          AND rel.relname = 'confidential_delegation_mappings'
          AND cn.nspname = $1
          AND p.proname = $2`,
      handle.schema,
      HELPER,
    );

    expect(rows).toEqual([
      { constraint_schema: handle.schema, function_schema: handle.schema },
    ]);
  });

  it('leaves PUBLIC without EXECUTE on the helper', async () => {
    if (!handle) throw new Error('db handle missing');

    // grantee 0 in aclexplode denotes PUBLIC; PUBLIC is not a role, so
    // has_function_privilege('PUBLIC', ...) cannot express this check.
    const rows = await handle.prisma.$queryRawUnsafe<Array<{ granted: bigint }>>(
      `SELECT COUNT(*) AS granted
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace,
         LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
        WHERE p.proname = $1
          AND n.nspname = $2
          AND acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'`,
      HELPER,
      handle.schema,
    );

    expect(rows[0]?.granted).toBe(BigInt(0));
  });

  it('denies the runtime app role and keeps EXECUTE for the admin role', async () => {
    if (!handle) throw new Error('db handle missing');

    const rows = await handle.prisma.$queryRawUnsafe<
      Array<{ app_can_execute: boolean; admin_can_execute: boolean }>
    >(
      `SELECT has_function_privilege('uoa_app', fn.oid, 'EXECUTE') AS app_can_execute,
              has_function_privilege('uoa_admin', fn.oid, 'EXECUTE') AS admin_can_execute
         FROM pg_proc fn
         JOIN pg_namespace n ON n.oid = fn.pronamespace
        WHERE fn.proname = $1
          AND n.nspname = $2`,
      HELPER,
      handle.schema,
    );

    expect(rows).toEqual([{ app_can_execute: false, admin_can_execute: true }]);
  });
});
