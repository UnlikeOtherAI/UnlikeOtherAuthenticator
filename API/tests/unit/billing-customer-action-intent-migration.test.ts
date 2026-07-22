import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260722140000_add_customer_billing_action_intents/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
);

describe('customer billing action intent migration', () => {
  it('serializes exact authority changes before accepting an intent', () => {
    expect(migration).toContain('FROM "billing_app_keys"');
    expect(migration).toContain('FROM "users"');
    expect(migration).toContain('FROM "organisations"');
    expect(migration).toContain('FROM "teams"');
    expect(migration).toContain('FROM "org_members"');
    expect(migration).toContain('FROM "team_members"');
    expect(migration.match(/FOR UPDATE;/g)).toHaveLength(7);
    expect(migration).toContain('app_key_row."purpose" IS DISTINCT FROM \'CUSTOMER_LIFECYCLE\'');
    expect(migration).toContain('team_row."org_id" IS DISTINCT FROM NEW."org_id"');
    expect(migration).toContain('org_member_row."status" IS DISTINCT FROM \'ACTIVE\'');
    expect(migration).toContain('team_member_row."status" IS DISTINCT FROM \'ACTIVE\'');
    expect(migration).toContain('NEW."authority_scope" = \'TEAM\'');
  });

  it('keeps the authorization evidence append-only and hidden from the app role', () => {
    expect(migration).toContain("IF TG_OP <> 'INSERT'");
    expect(migration).toContain(
      'REVOKE ALL ON TABLE "billing_customer_action_intents" FROM uoa_app',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE "billing_customer_action_intents" TO uoa_admin',
    );
    expect(migration).toContain('FOR ALL TO uoa_app USING (false) WITH CHECK (false)');
  });
});
