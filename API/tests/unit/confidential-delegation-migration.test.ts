import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../prisma/migrations/20260719020000_add_confidential_delegation_mappings/migration.sql',
  import.meta.url,
);

describe('confidential delegation mapping migration', () => {
  it('constrains exact domain/product mappings, HTTPS resources, and supported scopes', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain(
      `CREATE TYPE "ConfidentialDelegationScope" AS ENUM ('ai.invoke', 'billing.read')`,
    );
    expect(sql).toContain('confidential_delegation_mappings_client_domain_id_product_key');
    expect(sql).toContain('confidential_delegation_mappings_client_domain_id_fkey');
    expect(sql).toContain('confidential_delegation_mappings_product_check');
    expect(sql).toContain('confidential_delegation_mappings_resource_check');
    expect(sql).toContain('confidential_delegation_mappings_scopes_check');
    expect(sql).toContain('cardinality("scopes") BETWEEN 1 AND 2');
    expect(sql).toContain('ON DELETE CASCADE');
  });

  it('keeps mappings behind the admin role with forced deny-by-default RLS', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('REVOKE ALL ON TABLE "confidential_delegation_mappings" FROM "uoa_app"');
    expect(sql).toContain('ON TABLE "confidential_delegation_mappings" TO "uoa_admin"');
    expect(sql).toContain(
      'ALTER TABLE "confidential_delegation_mappings" FORCE ROW LEVEL SECURITY',
    );
    expect(sql).toContain('CREATE POLICY confidential_delegation_mappings_deny_app');
    expect(sql).toContain('FOR ALL TO uoa_app USING (false) WITH CHECK (false)');
  });
});
