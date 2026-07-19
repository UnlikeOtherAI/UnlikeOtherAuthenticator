import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../prisma/migrations/20260719010000_add_billing_tariff_control_plane/migration.sql',
  import.meta.url,
);
const collectionMigrationUrl = new URL(
  '../../prisma/migrations/20260719030000_add_billing_collection_mode/migration.sql',
  import.meta.url,
);
const stripeMigrationUrl = new URL(
  '../../prisma/migrations/20260719040000_add_stripe_collection_foundation/migration.sql',
  import.meta.url,
);
const stripeHardeningMigrationUrl = new URL(
  '../../prisma/migrations/20260719060000_harden_stripe_account_and_subscription_lifecycle/migration.sql',
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

  it('makes payment collection explicit and immutable on every tariff version', async () => {
    const sql = await readFile(collectionMigrationUrl, 'utf8');

    expect(sql).toContain(
      "CREATE TYPE \"BillingCollectionMode\" AS ENUM ('STRIPE', 'MANUAL', 'NONE')",
    );
    expect(sql).toContain('"collection_mode" "BillingCollectionMode" NOT NULL');
    expect(sql).toContain('"mode" = \'FREE\'');
    expect(sql).toContain('"collection_mode" = \'NONE\'');
    expect(sql).toContain('NEW."collection_mode" IS DISTINCT FROM OLD."collection_mode"');
  });

  it('keeps Stripe mappings scope-bound, replay-safe, and inaccessible to the app role', async () => {
    const sql = await readFile(stripeMigrationUrl, 'utf8');

    expect(sql).toContain('billing_stripe_checkout_sessions_one_open_scope');
    expect(sql).toContain('billing_stripe_subscriptions_one_live_scope');
    expect(sql).toContain('billing_stripe_tariff_prices_coherent');
    expect(sql).toContain('uoa_enforce_billing_stripe_scope_coherence');
    expect(sql).toContain('"app_key_id"');
    expect(sql).toContain('"requested_by_user_id"');
    for (const table of [
      'billing_stripe_customers',
      'billing_stripe_catalogs',
      'billing_stripe_tariff_prices',
      'billing_stripe_checkout_sessions',
      'billing_stripe_subscriptions',
      'billing_stripe_webhook_events',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON TABLE "${table}" FROM "uoa_app"`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
  });

  it('binds every Stripe projection to account and mode with recoverable leases', async () => {
    const sql = await readFile(stripeHardeningMigrationUrl, 'utf8');

    expect(sql).toContain('billing_stripe_accounts_stripe_account_id_livemode_key');
    expect(sql).toContain(
      'billing_stripe_checkout_sessions_account_id_stripe_checkout_session_id_key',
    );
    expect(sql).toContain('billing_stripe_subscriptions_account_id_stripe_subscription_id_key');
    expect(sql).toContain('"lease_expires_at" TIMESTAMP(3) NOT NULL');
    expect(sql).toContain("'abandoned'");
    expect(sql).toContain('uoa_enforce_stripe_scope_exclusivity');
    expect(sql).toContain('uoa_guard_stripe_default_tariff');
    expect(sql).toContain('uoa_guard_stripe_tariff_assignment');
    expect(sql).toContain('billing_stripe_tariff_prices_zero_monthly_check');
    expect(sql).toContain(
      'checkout."tariff_assignment_id" IS NOT DISTINCT FROM NEW."tariff_assignment_id"',
    );
    expect(sql).toContain('billing_stripe_accounts_deny_app');
  });
});
