import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

// A unique disposable schema: no existing tenant, mapping, or grant is touched.
describe.skipIf(!process.env.DATABASE_URL)('memory delegation vocabulary migration', () => {
  it('retains old grants and enforces exact non-duplicate scope arrays in Postgres', async () => {
    const schema = `memory_scope_${randomUUID().replaceAll('-', '')}`;
    const admin = new PrismaClient();
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('schema', schema);
    const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await db.$executeRawUnsafe(
        `CREATE TYPE "ConfidentialDelegationScope" AS ENUM ('ai.invoke', 'billing.read', 'token.provision')`,
      );
      await db.$executeRawUnsafe(`CREATE TABLE "confidential_delegation_mappings" (
        id text PRIMARY KEY, scopes "ConfidentialDelegationScope"[] NOT NULL,
        CONSTRAINT "confidential_delegation_mappings_scopes_check" CHECK (cardinality(scopes) BETWEEN 1 AND 3)
      )`);
      await db.$executeRawUnsafe(
        `INSERT INTO confidential_delegation_mappings VALUES ('existing', ARRAY['ai.invoke']::"ConfidentialDelegationScope"[])`,
      );
      const migration = await readFile(
        new URL(
          '../../prisma/migrations/20260930170000_add_memory_delegation_scopes/migration.sql',
          import.meta.url,
        ),
        'utf8',
      );
      for (const statement of migration
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)) {
        await db.$executeRawUnsafe(statement);
      }
      expect(
        await db.$queryRawUnsafe(
          `SELECT scopes::text[] AS scopes FROM confidential_delegation_mappings WHERE id = 'existing'`,
        ),
      ).toEqual([{ scopes: ['ai.invoke'] }]);
      await db.$executeRawUnsafe(
        `INSERT INTO confidential_delegation_mappings VALUES ('memory', ARRAY['memory.read', 'memory.write']::"ConfidentialDelegationScope"[])`,
      );
      for (const expression of [
        "ARRAY['memory.read','memory.read']",
        "ARRAY['memory.write',NULL]",
        'ARRAY[]',
        "ARRAY[['memory.read','memory.write']]",
        "ARRAY['ai.invoke','billing.read','token.provision','memory.read','memory.read']",
      ]) {
        await expect(
          db.$executeRawUnsafe(
            `INSERT INTO confidential_delegation_mappings VALUES ('invalid', ${expression}::"ConfidentialDelegationScope"[])`,
          ),
        ).rejects.toThrow();
      }
    } finally {
      await db.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });
});
