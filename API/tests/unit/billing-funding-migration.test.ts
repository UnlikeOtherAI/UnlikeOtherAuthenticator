import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../prisma/migrations/20260721120000_add_billing_funding_foundation/migration.sql',
  import.meta.url,
);
const hardeningMigrationUrl = new URL(
  '../../prisma/migrations/20260721180000_harden_credit_funding_lifecycle/migration.sql',
  import.meta.url,
);

describe('billing funding foundation migration', () => {
  it('keeps one exact shared team credit account and fixed public conversion', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain(
      'CREATE UNIQUE INDEX "billing_credit_accounts_account_id_team_id_currency_key"',
    );
    expect(sql).toContain('"credits_received_microcredits"::numeric');
    expect(sql).toContain('= "payment_amount_minor"::numeric * 10000000');
    expect(sql).toContain('"delta_remaining_usage_amount_micro_minor"::numeric * 10');
    expect(sql).toContain('- "delta_credits_consumed_microcredits"::numeric');
    expect(sql).toContain('billing_credit_entries_append_only');
    expect(sql).toContain('billing_credit_accounts_balance_guard');
    expect(sql).toContain('billing_credit_top_up_offers_policy_id_fkey');
    expect(sql).toContain('billing_credit_entries_reverses_entry_id_idx');
  });

  it('requires product provenance and exact Stripe evidence for every paid credit', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('billing_assert_credit_app_key');
    expect(sql).toContain('key."purpose" = \'CUSTOMER_LIFECYCLE\'');
    expect(sql).toContain('completed credit checkout proof is immutable');
    expect(sql).toContain('successful automatic top-up does not match its immutable entry');
    expect(sql).toContain('Stripe payment adjustment evidence is not exact');
    expect(sql).not.toContain('\'REVERSAL\'::"BillingCreditEntryKind"');
  });

  it('makes consent immutable, caps automatic charges, and fails closed after payment trouble', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('billing_credit_consent_revisions_append_only');
    expect(sql).toContain('billing_credit_auto_top_up_attempts_one_unresolved');
    expect(sql).toContain('automatic top-up monthly charge snapshot or cap is stale');
    expect(sql).toContain('NEW."billing_month" := to_char(CURRENT_TIMESTAMP AT TIME ZONE');
    expect(sql).toContain('automatic top-up recovery requires a new verified consent revision');
    expect(sql).toContain('SET "auto_top_up_state" = \'NEEDS_REVIEW\'');
  });

  it('requires active exact-team managers and scope-aware add-on authority', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('CREATE FUNCTION "billing_assert_credit_team_manager"');
    expect(sql).toContain('billing action requires an active exact-team manager');
    expect(sql.match(/NEW\."scope" <> 'ORGANISATION'/g)).toHaveLength(2);
    expect(sql).toContain('recurring add-on checkout requires a billing manager');
    expect(sql).toContain('new recurring add-on cancellation intent is not available');
  });

  it('pins settlement corrections to one Ledger snapshot perspective and latest invoice line', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('"perspective_service_id"');
    expect(sql).toContain('"group_by" = \'user\'');
    expect(sql).toContain(
      'settlement adjustment must use the exact team-wide user portfolio snapshot',
    );
    expect(sql).toContain('settlement adjustment sequence does not continue the locked chain');
    expect(sql).toContain('usage allocation totals must equal the aggregate settlement adjustment');
    expect(sql).toContain('Stripe credit line must project the latest exact settlement cumulative');
  });

  it('binds add-on checkout, paid entitlement, and cancellation to exact immutable subjects', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('billing_recurring_addon_checkouts_one_unresolved_scope');
    expect(sql).toContain('billing_recurring_addon_subscriptions_one_live_scope');
    expect(sql).toContain('recurring add-on entitlement lacks exact paid invoice evidence');
    expect(sql).toContain('CREATE TABLE "billing_recurring_addon_cancellation_intents"');
    expect(sql).toContain('"requested_team_id" TEXT NOT NULL');
    expect(sql).toContain('billing_recurring_addon_cancel_intents_one_unresolved');
    expect(sql).toContain('recurring add-on cancellation actor tenancy is inactive');
    expect(sql).toContain('recurring add-on cancellation intent has expired');
    expect(sql).toContain('completed recurring add-on cancellation proof is immutable');
  });

  it('requires a trusted configured admin domain for manual credit adjustments', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain("current_setting('app.admin_auth_domain', true)");
    expect(sql).toContain('NEW."created_by_admin_domain"');
    expect(sql).toContain('role."role" = \'SUPERUSER\'');
    expect(sql).toContain('credit admin adjustment requires exact team and superuser evidence');
  });

  it('keeps all commercial funding tables inaccessible to the ordinary app role', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    for (const table of [
      'billing_credit_accounts',
      'billing_credit_entries',
      'billing_credit_auto_top_up_consent_revisions',
      'billing_credit_auto_top_up_attempts',
      'billing_credit_usage_settlements',
      'billing_recurring_addon_subscriptions',
      'billing_recurring_addon_cancellation_intents',
    ]) {
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain("EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name)");
    expect(sql).toContain("'CREATE POLICY %I ON %I FOR ALL TO uoa_app USING (false)");
  });
});

describe('billing funding lifecycle hardening migration', () => {
  it('pins setup activation to an exact locked consent predecessor', async () => {
    const sql = await readFile(hardeningMigrationUrl, 'utf8');

    expect(sql).toContain('"auto_top_up_generation" INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('"expected_consent_revision_id" TEXT');
    expect(sql).toContain('billing_credit_setup_predecessor_guard');
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('automatic top-up setup predecessor changed');
    expect(sql).toContain('automatic top-up consent change must advance generation once');
  });

  it('requires a current database-verified manager audit for disable', async () => {
    const sql = await readFile(hardeningMigrationUrl, 'utf8');

    expect(sql).toContain('CREATE TABLE "billing_credit_auto_top_up_disable_events"');
    expect(sql).toContain('billing_credit_auto_top_up_disable_event_coherence');
    expect(sql).toContain('billing_assert_credit_team_manager');
    expect(sql).toContain('automatic top-up disable requires manager-audited evidence');
    expect(sql).toContain('billing_credit_auto_top_up_disable_event_append_only');
    expect(sql).toContain(
      'GRANT SELECT, INSERT ON TABLE "billing_credit_auto_top_up_disable_events" TO uoa_admin',
    );
  });
});
