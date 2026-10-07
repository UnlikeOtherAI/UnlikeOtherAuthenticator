import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { allocateInvoiceCreditReferenceMinor } from '../../src/services/billing-invoice-line-credit-allocation.service.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' &&
  Boolean(process.env.DATABASE_URL);
type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

describe.skipIf(!enabled)('invoice credit bytewise settlement order', () => {
  let db: TestDb;
  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
  });
  afterAll(async () => { await db?.cleanup(); });

  it('assigns the fractional cent in the same order as PostgreSQL COLLATE C', async () => {
    const references = ['ä', 'a', 'A', 'B'].map((serviceId) => ({
      id: `ref-${serviceId}`, serviceId, settlementId: `settlement-${serviceId}`,
      creditsAppliedMicrocredits: 2_500_000n,
    }));
    const postgres = await db.prisma.$queryRaw<Array<{
      service_id: string; amount_minor: bigint;
    }>>`
      WITH ordered AS (
        SELECT service_id, microcredits,
          sum(microcredits::numeric) OVER (
            ORDER BY service_id COLLATE "C"
          ) AS cumulative
        FROM (VALUES ('ä', 2500000::bigint), ('a', 2500000::bigint),
          ('A', 2500000::bigint), ('B', 2500000::bigint)) AS refs(service_id, microcredits)
      )
      SELECT service_id, (
        floor((cumulative + 5000000) / 10000000) -
        floor((cumulative - microcredits + 5000000) / 10000000)
      )::bigint AS amount_minor
      FROM ordered ORDER BY service_id COLLATE "C"
    `;
    const allocated = allocateInvoiceCreditReferenceMinor(references);
    expect(allocated.map((row) => row.serviceId))
      .toEqual(postgres.map((row) => row.service_id));
    expect(allocated.map((row) => row.amountMinor)).toEqual([0n, 1n, 0n, 0n]);
    expect(allocated.map((row) => row.amountMinor))
      .toEqual(postgres.map((row) => row.amount_minor));
    expect(allocated.reduce((total, row) => total + row.amountMinor, 0n)).toBe(1n);
  });
});
