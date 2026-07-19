import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../prisma/migrations/20260719010000_add_billing_tariff_control_plane/migration.sql',
  import.meta.url,
);

describe('billing tariff control-plane migration', () => {
  it('enforces immutable version identities and one default tariff per service', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('billing_tariffs_service_id_key_version_key');
    expect(sql).toContain('billing_tariffs_one_default_per_service');
    expect(sql).toContain('WHERE "is_default" = true');
    expect(sql).toContain('billing_tariff_assignments_service_id_scope_scope_key_key');
    expect(sql).toContain('billing_tariffs_mode_values_check');
    expect(sql).toContain('billing_tariff_assignments_scope_check');
    expect(sql).toContain('billing_tariffs_immutable');
    expect(sql).toContain('billing_tariff_assignments_coherent');
    expect(sql).toContain('"service_id" = NEW."service_id"');
    expect(sql).toContain('"org_id" = NEW."org_id"');
  });

  it('keeps tariff state and app credentials behind the admin database role', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    for (const table of [
      'billing_services',
      'billing_tariffs',
      'billing_tariff_assignments',
      'billing_app_keys',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON TABLE "${table}" FROM "uoa_app"`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO "uoa_admin"`,
      );
    }
  });
});
