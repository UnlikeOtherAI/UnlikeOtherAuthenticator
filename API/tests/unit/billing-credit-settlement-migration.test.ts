import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../prisma/migrations/20260721140000_add_credit_settlement_runtime_coherence/migration.sql',
  import.meta.url,
);

describe('all-service credit settlement runtime migration', () => {
  it('treats the authenticated storefront key as lifecycle provenance, not billed-service selection', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('CREATE FUNCTION "billing_assert_credit_app_key_provenance"');
    expect(sql).toContain("key.\"purpose\" = 'CUSTOMER_LIFECYCLE'");
    expect(sql).toContain('PERFORM "billing_assert_credit_app_key_provenance"(NEW."app_key_id", true)');
    expect(sql).toContain(
      'settlement adjustment must use the exact team-wide user portfolio snapshot',
    );
    expect(sql).not.toContain(
      'snapshot_row."perspective_service_id" IS DISTINCT FROM NEW."service_id"',
    );
  });

  it('retains the hard guard that rated usage can never make the balance negative', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain("NEW.\"kind\" IN ('USAGE_SETTLEMENT', 'USAGE_SETTLEMENT_CORRECTION')");
    expect(sql).toContain("AND NEW.\"direction\" = 'DEBIT'");
    expect(sql).toContain('AND next_balance < 0');
    expect(sql).toContain('rated usage cannot consume more credits than are available');
  });

  it('allows a new cursor with a zero aggregate delta while preserving exact liability math', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain(
      'DROP CONSTRAINT "billing_credit_usage_settlement_adjustments_delta_check"',
    );
    expect(sql).toContain('"delta_remaining_usage_amount_micro_minor"::numeric * 10');
    expect(sql).toContain('- "delta_credits_consumed_microcredits"::numeric');
    expect(sql).toContain(
      '("delta_credits_consumed_microcredits" = 0 AND "credit_entry_id" IS NULL)',
    );
    expect(sql).toContain('usage allocation does not continue its per-user cumulative chain');
  });
});
