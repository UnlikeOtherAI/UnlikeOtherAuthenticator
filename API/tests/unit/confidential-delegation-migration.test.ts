import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../prisma/migrations/20260719020000_add_confidential_delegation_mappings/migration.sql',
  import.meta.url,
);
const tokenProvisionMigrationUrl = new URL(
  '../../prisma/migrations/20260719050000_add_token_provision_delegation_scope/migration.sql',
  import.meta.url,
);
const identityMembershipMigrationUrl = new URL(
  '../../prisma/migrations/20260814120000_add_identity_membership_delegation_scopes/migration.sql',
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

  it('adds identity/membership scopes without weakening exact non-duplicate scope bounds', async () => {
    const sql = await readFile(identityMembershipMigrationUrl, 'utf8');

    expect(sql).toContain(
      `ALTER TYPE "ConfidentialDelegationScope" ADD VALUE IF NOT EXISTS 'identity.read'`,
    );
    expect(sql).toContain(
      `ALTER TYPE "ConfidentialDelegationScope" ADD VALUE IF NOT EXISTS 'membership.invite'`,
    );
    expect(sql).toContain(
      `ALTER TYPE "ConfidentialDelegationScope" ADD VALUE IF NOT EXISTS 'membership.manage'`,
    );
    expect(sql).toContain('DROP CONSTRAINT "confidential_delegation_mappings_scopes_check"');
    expect(sql).toContain('CHECK (confidential_delegation_scopes_unique("scopes"))');
    expect(sql).toContain('IMMUTABLE');
    expect(sql).toContain('STRICT');
    expect(sql).toContain('cardinality(scopes) BETWEEN 1 AND 6');
    expect(sql).toContain('array_position(scopes, NULL) IS NULL');
    expect(sql).toContain('ARRAY(SELECT DISTINCT unnest(scopes))');
  });

  it('creates the scope helper in the current schema, not a hardcoded public schema', async () => {
    const sql = await readFile(identityMembershipMigrationUrl, 'utf8');

    // The function is created and referenced unqualified so it lands in
    // current_schema() (the isolated schema under test), and every ACL
    // statement resolves through current_schema() at runtime.
    expect(sql).not.toContain('public.confidential_delegation_scopes_unique');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION confidential_delegation_scopes_unique(');
    expect(sql).toContain('SET search_path = pg_catalog, pg_temp');
    expect(sql).toContain('current_schema()');
    expect(sql).toContain(
      `EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.confidential_delegation_scopes_unique("ConfidentialDelegationScope"[]) FROM PUBLIC',
    current_schema()
  )`,
    );
  });

  it('revokes PUBLIC and the runtime app role, granting only the admin role', async () => {
    const sql = await readFile(identityMembershipMigrationUrl, 'utf8');

    expect(sql).toContain('FROM PUBLIC');
    expect(sql).toContain(`IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app')`);
    expect(sql).toContain(`IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin')`);
    expect(sql).toContain(`FROM %I',\n      current_schema(), 'uoa_app'`);
    expect(sql).toContain(`TO %I',\n      current_schema(), 'uoa_admin'`);
  });

  it('revokes helper EXECUTE from PUBLIC and the app role, granting only guarded privileged roles', async () => {
    const sql = await readFile(identityMembershipMigrationUrl, 'utf8');

    // CREATE FUNCTION grants EXECUTE to PUBLIC by default; the regression this
    // guards against is revoking only uoa_app while PUBLIC keeps EXECUTE.
    // The ACL block is dynamic SQL pinned through current_schema() so the
    // same migration works under an isolated test schema; every REVOKE/GRANT
    // targets the helper by name.
    const acls = sql.match(
      /(REVOKE ALL|GRANT EXECUTE) ON FUNCTION %I\.confidential_delegation_scopes_unique[\s\S]*?(FROM|TO) (PUBLIC|%I)/g,
    );
    expect(acls?.length).toBe(3);
    expect(acls?.filter((acl) => acl.startsWith('REVOKE')).length).toBe(2);
    expect(acls?.filter((acl) => acl.startsWith('GRANT')).length).toBe(1);
    // Grants go only to the admin role and are existence-guarded so a missing
    // role never aborts the migration.
    expect(sql).toContain(`IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN`);
    expect(sql).toContain(`IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN`);
    expect(sql).toContain(`'uoa_admin'`);
    expect(sql).toContain(`'uoa_app'`);
  });

  it('adds token.provision without weakening exact non-duplicate scope bounds', async () => {
    const sql = await readFile(tokenProvisionMigrationUrl, 'utf8');

    expect(sql).toContain(
      `ALTER TYPE "ConfidentialDelegationScope" ADD VALUE IF NOT EXISTS 'token.provision'`,
    );
    expect(sql).toContain('DROP CONSTRAINT "confidential_delegation_mappings_scopes_check"');
    expect(sql).toContain('cardinality("scopes") BETWEEN 1 AND 3');
    expect(sql).toContain('array_position("scopes", NULL) IS NULL');
    expect(sql).toContain('"scopes"[1] <> "scopes"[3]');
    expect(sql).toContain('"scopes"[2] <> "scopes"[3]');
  });
});
