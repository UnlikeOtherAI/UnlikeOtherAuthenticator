import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runWithTenantContext } from '../../src/db/tenant-context.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

/**
 * These tests exercise `runWithTenantContext` against a real Postgres. They do NOT
 * exercise the full M1/M2 RLS migration — that requires `uoa_app` and `uoa_admin`
 * roles to be provisioned in the database, which is a DBA-owned step, not something
 * createTestDb does. They validate that:
 *
 *   1. The helper opens an interactive transaction.
 *   2. `set_config('app.domain' | 'app.org_id' | 'app.user_id', value, true)` is
 *      applied correctly — both the values and the transaction-scoped lifetime.
 *   3. Nested `$transaction` calls become savepoints and inherit the GUCs.
 *
 * Full cross-tenant isolation tests (assert `uoa_app` with domain=A cannot see
 * domain=B rows) belong in the M1/M2 soak checklist (see row-level-security.md §11).
 * They require production-like role setup and are tracked there, not here.
 */
describe.skipIf(!hasDatabase)('runWithTenantContext — real Postgres', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
  });

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('sets app.domain / app.org_id / app.user_id inside the transaction', async () => {
    if (!handle) throw new Error('db handle missing');

    const observed = await runWithTenantContext(
      {
        prisma: handle.prisma,
        context: { domain: 'app.example.com', orgId: 'org-123', userId: 'user-456' },
      },
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ name: string; value: string }>>`
          SELECT 'app.domain' AS name, current_setting('app.domain', true) AS value
          UNION ALL
          SELECT 'app.org_id', current_setting('app.org_id', true)
          UNION ALL
          SELECT 'app.user_id', current_setting('app.user_id', true)
        `;
        return Object.fromEntries(rows.map((row) => [row.name, row.value]));
      },
    );

    expect(observed).toEqual({
      'app.domain': 'app.example.com',
      'app.org_id': 'org-123',
      'app.user_id': 'user-456',
    });
  });

  it('coalesces missing orgId/userId to empty strings', async () => {
    if (!handle) throw new Error('db handle missing');

    const observed = await runWithTenantContext(
      { prisma: handle.prisma, context: { domain: 'app.example.com' } },
      async (tx) =>
        tx.$queryRaw<Array<{ value: string }>>`
          SELECT current_setting('app.org_id', true) AS value
        `,
    );

    expect(observed[0]?.value).toBe('');
  });

  it('scopes settings to the transaction (next transaction sees empty values)', async () => {
    if (!handle) throw new Error('db handle missing');

    await runWithTenantContext(
      { prisma: handle.prisma, context: { domain: 'first.example.com' } },
      async () => null,
    );

    const afterRows = await handle.prisma.$queryRaw<Array<{ value: string }>>`
      SELECT current_setting('app.domain', true) AS value
    `;

    expect(afterRows[0]?.value ?? '').toBe('');
  });

  it('inherits GUCs through a nested $transaction savepoint', async () => {
    if (!handle) throw new Error('db handle missing');

    const innerValue = await runWithTenantContext(
      {
        prisma: handle.prisma,
        context: { domain: 'outer.example.com', orgId: 'outer-org' },
      },
      async (tx) => {
        return tx.$transaction(async (inner) => {
          const rows = await inner.$queryRaw<Array<{ value: string }>>`
            SELECT current_setting('app.domain', true) AS value
          `;
          return rows[0]?.value ?? null;
        });
      },
    );

    expect(innerValue).toBe('outer.example.com');
  });
});
