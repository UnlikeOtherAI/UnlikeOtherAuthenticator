import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

describe.skipIf(!process.env.DATABASE_URL)('privileged seat schema authority', () => {
  let db: TestDb;
  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
  });
  afterAll(async () => { await db?.cleanup(); });

  it('retains explicit trusted and temporary schema order after all migrations', async () => {
    const functions = await db.prisma.$queryRaw<Array<{ proname: string; proconfig: string[] }>>`
      SELECT proname, proconfig FROM pg_proc
      WHERE pronamespace = current_schema()::regnamespace AND proname IN (
        'billing_seat_touch_org', 'billing_seat_touch_change', 'billing_seat_eligible',
        'billing_seat_refresh_org', 'billing_seat_refresh_change')
    `;
    expect(functions).toHaveLength(5);
    for (const fn of functions) {
      expect(fn.proconfig, fn.proname).toEqual([
        expect.stringMatching(/^search_path=pg_catalog, [^,]+, pg_temp$/),
      ]);
    }
  });

  it('never updates a temporary organisation shadow through the definer', async () => {
    await db.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        CREATE TEMP TABLE organisations (id text PRIMARY KEY, billing_seat_guard_version bigint)
        ON COMMIT DROP
      `;
      await tx.$executeRaw`INSERT INTO pg_temp.organisations VALUES ('shadow_org', 0)`;
      await tx.$queryRaw`SELECT billing_seat_touch_org('shadow_org')::text`;
      const shadows = await tx.$queryRaw<Array<{ version: bigint }>>`
        SELECT billing_seat_guard_version AS version FROM pg_temp.organisations
      `;
      expect(shadows).toEqual([{ version: 0n }]);
    });
  });
});
