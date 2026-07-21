import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../prisma/migrations/20260721130000_add_contract_invoicing_foundation/migration.sql',
  import.meta.url,
);

const protectedTables = [
  'billing_organisation_contracts',
  'billing_organisation_contract_versions',
  'billing_contract_service_terms',
  'billing_invoice_issuer_profiles',
  'billing_organisation_invoice_profiles',
  'billing_invoices',
  'billing_invoice_lines',
  'billing_invoice_metering_references',
  'billing_invoice_credit_settlement_references',
  'billing_invoice_addon_lines',
  'billing_invoice_number_sequences',
  'billing_invoice_payment_events',
];

function tableDefinition(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE "${table}"`);
  const end = sql.indexOf('\n);', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('contract invoicing migration', () => {
  it('pins immutable organisation contract versions to generated service terms', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain(
      `CREATE TYPE "BillingOrganisationContractStatus" AS ENUM ('DRAFT', 'ACTIVE', 'TERMINATED')`,
    );
    expect(sql).toContain('billing_organisation_contracts_one_active_org');
    expect(sql).toContain('WHERE "status" = \'ACTIVE\'');
    expect(sql).toContain('billing_organisation_contract_versions_immutable');
    expect(sql).toContain("RAISE EXCEPTION 'contract versions are immutable'");
    expect(sql).toContain("RAISE EXCEPTION 'contract version must be contiguous'");
    expect(sql).toContain("RAISE EXCEPTION 'contract version month must move forward'");
    expect(sql).toContain("pg_advisory_xact_lock(hashtextextended('uoa-contract:'");
    expect(sql).toContain("RAISE EXCEPTION 'contract version cannot change an invoiced period'");
    expect(sql).toContain('billing_contract_service_terms_immutable');
    expect(sql).toContain('"tariff_id" TEXT NOT NULL');
    expect(sql).toContain('"tariff_assignment_id" TEXT');
    expect(sql).not.toContain('"tariff_assignment_id" TEXT NOT NULL');
    expect(sql).toContain('ON DELETE SET NULL ON UPDATE CASCADE');
    expect(sql).toContain("to_jsonb(NEW) - 'tariff_assignment_id'");
    expect(sql).toContain('AND "mode" = \'CUSTOM\' AND "collection_mode" = \'MANUAL\'');
    expect(sql).toContain('AND "scope" = \'ORGANISATION\'');
    expect(sql).toContain('AND "team_id" IS NULL AND "scope_key" = parent_org_id');
    expect(sql).toContain('uoa_lock_stripe_contract_scope');
    expect(sql).toContain('uoa_stripe_scope_blocks_manual_contract');
    expect(sql).toContain('FOR activation_service_id IN');
    expect(sql).toContain('checkout."status" = \'complete\'');
    expect(sql).toContain('billing_stripe_subscription_contract_exclusive');
    expect(sql).toContain(
      "RAISE EXCEPTION 'active manual contract blocks Stripe checkout or subscription projection'",
    );
    expect(sql).toContain("RAISE EXCEPTION 'contract activation timestamp is immutable'");
    expect(sql).toContain("RAISE EXCEPTION 'contract termination timestamp is immutable'");
  });

  it('stores one display-safe final price per service and private Ledger provenance separately', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    const lines = tableDefinition(sql, 'billing_invoice_lines');
    const metering = tableDefinition(sql, 'billing_invoice_metering_references');

    expect(lines).toContain('"service_identifier" VARCHAR(100) NOT NULL');
    expect(lines).toContain('"service_name" VARCHAR(120) NOT NULL');
    expect(lines).toContain('"amount_minor" BIGINT NOT NULL');
    expect(sql).toContain('billing_invoice_lines_invoice_id_service_id_key');
    for (const forbidden of ['token', 'usage_unit', 'provider_cost', 'markup', 'meter_quantity']) {
      expect(lines).not.toContain(forbidden);
    }

    expect(metering).toContain('"ledger_snapshot_cursor" TEXT NOT NULL');
    expect(metering).toContain('"ledger_snapshot_sha256" CHAR(64) NOT NULL');
    expect(metering).not.toContain('amount');
    expect(metering).not.toContain('cost');
    expect(sql).toContain('billing_invoice_metering_references_invoice_id_service_id_key');
  });

  it('guards issuance, unique numbering, active-month exclusivity, and issued immutability', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain(
      `CREATE TYPE "BillingInvoiceStatus" AS ENUM ('DRAFT', 'ISSUING', 'ISSUED', 'VOID')`,
    );
    expect(sql).toContain('billing_invoices_invoice_number_key');
    expect(sql).toContain('billing_invoice_issuer_profiles_invoice_number_prefix_key');
    expect(sql).toContain('billing_invoices_one_active_issue');
    expect(sql).toContain('ON "billing_invoices"("org_id", "billing_month", "currency")');
    expect(sql).toContain("WHERE \"status\" IN ('ISSUING', 'ISSUED')");
    expect(sql).toContain('"total_minor" = "subtotal_minor" + "tax_amount_minor"');
    expect(sql).toContain('billing_invoices_pdf_check');
    expect(sql).toContain('"pdf_sha256" ~ \'^[a-f0-9]{64}$\'');
    expect(sql).toContain('billing_invoices_guarded');
    expect(sql).toContain("RAISE EXCEPTION 'calculated invoice commercial fields are immutable'");
    expect(sql).toContain("RAISE EXCEPTION 'calculated invoice evidence is immutable'");
    expect(sql).toContain('xmin = pg_current_xact_id()::xid');
    expect(sql).toContain("RAISE EXCEPTION 'issued invoice artifacts are immutable'");
    expect(sql).toContain("RAISE EXCEPTION 'issued invoice identity and dates are immutable'");
    expect(sql).toContain('\'uoa-invoice-revision:\' || NEW."contract_id"');
    expect(sql).toContain("RAISE EXCEPTION 'invoice revision must be contiguous'");
    expect(sql).toContain("RAISE EXCEPTION 'invoice is not ready for issuance'");
    expect(sql).toContain('EXCEPT (SELECT "service_id" FROM "billing_invoice_lines"');
    expect(sql).toContain('EXCEPT (SELECT "service_id" FROM "billing_invoice_metering_references"');
  });

  it('makes settlement events append-only and invoice numbers monotonic', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain(
      `CREATE TYPE "BillingInvoicePaymentEventKind" AS ENUM ('PAYMENT', 'REFUND', 'WRITE_OFF')`,
    );
    expect(sql).toContain(`CREATE TYPE "BillingInvoicePaymentEventSource" AS ENUM ('MANUAL')`);
    expect(sql).not.toContain(`BillingInvoicePaymentEventSource" AS ENUM ('MANUAL', 'STRIPE')`);
    expect(sql).toContain('billing_invoice_payment_events_append_only');
    expect(sql).toContain(
      'billing_invoice_payment_events_amount_check" CHECK ("amount_minor" > 0)',
    );
    expect(sql).toContain("RAISE EXCEPTION 'invoice payment events are append-only'");
    expect(sql).toContain(
      'payments < refunds OR invoice_credits + payments - refunds + write_offs > invoice_total',
    );
    expect(sql).toContain('billing_invoice_number_sequences_monotonic');
    expect(sql).toContain('NEW."last_value" <> OLD."last_value" + 1');
    expect(sql).toContain("RAISE EXCEPTION 'settled invoices cannot be voided'");
  });

  it('requires a billing email and preserves credits as a separate settlement value', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    const issuers = tableDefinition(sql, 'billing_invoice_issuer_profiles');
    const invoices = tableDefinition(sql, 'billing_invoices');

    expect(issuers).toContain('"billing_email" CITEXT NOT NULL');
    expect(invoices).toContain('"credits_applied_minor" BIGINT NOT NULL DEFAULT 0');
    expect(invoices).toContain('"credits_applied_minor" <= "total_minor"');
    expect(sql).toContain('billing_invoice_credit_settlement_references');
    expect(sql).toContain("'uoa-credit-collector:' || collector_settlement_id");
    expect(sql).toContain('credit settlement already has a Stripe collector');
    expect(sql).toContain('credit settlement already has a manual invoice collector');
    expect(sql).toContain('billing_credit_invoice_lines_single_collector');
  });

  it('snapshots paid recurring add-ons as separately collected display lines', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    const addons = tableDefinition(sql, 'billing_invoice_addon_lines');

    expect(addons).toContain('"service_identifier" VARCHAR(100) NOT NULL');
    expect(addons).toContain('"service_name" VARCHAR(120) NOT NULL');
    expect(addons).toContain('"offer_version" INTEGER NOT NULL');
    expect(addons).toContain('"catalog_id" TEXT NOT NULL');
    expect(addons).toContain('"collection" "BillingInvoiceAddonCollection" NOT NULL');
    expect(sql).toContain('NEW."collection" IS DISTINCT FROM \'STRIPE_SEPARATE\'');
    expect(sql).toContain('invoice add-on line is not an exact separately billed subscription');
  });

  it('keeps every contract and invoice table behind the admin database role', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    for (const table of protectedTables) {
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain('REVOKE ALL ON TABLE %I FROM uoa_app');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO uoa_admin');
    expect(sql).toContain('ALTER TABLE %I FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('FOR ALL TO uoa_app USING (false) WITH CHECK (false)');
  });
});
