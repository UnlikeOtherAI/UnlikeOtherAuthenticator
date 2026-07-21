import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../prisma/migrations/20260721182000_guard_credited_invoice_void/migration.sql',
  import.meta.url,
);

describe('billing invoice issue-readiness migration', () => {
  it('blocks voiding on exact settlement evidence instead of a rounded header', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    const voidGuard = sql.slice(0, sql.indexOf('-- Canonical issue readiness'));

    expect(voidGuard).toContain('FROM "billing_invoice_credit_settlement_references"');
    expect(voidGuard).toContain('FROM "billing_invoice_payment_events"');
    expect(voidGuard).not.toContain('credits_applied_minor');
    expect(voidGuard).toContain("RAISE EXCEPTION 'settled invoices cannot be voided'");
  });

  it('defines one canonical, exact readiness predicate for draft issuance', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION uoa_billing_invoice_issue_ready(target_invoice_id TEXT)',
    );
    expect(sql).toContain('invoice."status" = \'DRAFT\'');
    expect(sql).toContain('contract."status" = \'ACTIVE\'');
    expect(sql).toContain('issuer."active" = true');
    expect(sql).toContain("other_invoice.\"status\" IN ('ISSUING', 'ISSUED')");
    expect(sql).toContain('SELECT 1 FROM "billing_invoice_lines"');
    expect(sql).toContain('FROM "billing_contract_service_terms"');
    expect(sql).toContain('FROM "billing_invoice_metering_references"');
    expect(sql).toContain('sum(line."amount_minor")');
    expect(sql).toContain('sum(reference."credits_applied_microcredits")');
    expect(sql).toContain('+ 5000000');
    expect(sql).toContain('/ 10000000');
    expect(sql).toContain('settlement."status" <> \'APPLIED\'');
    expect(sql).toContain('ORDER BY latest."sequence" DESC');
    expect(sql).toContain("stripe_line.\"status\" IN ('CREATING', 'APPLIED')");
    expect(sql).toContain('other_reference."settlement_id" = reference."settlement_id"');
  });

  it('guards every draft-to-issuing transition with the canonical predicate', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('CREATE TRIGGER billing_invoices_issue_readiness_guard');
    expect(sql).toContain('BEFORE UPDATE OF "status" ON "billing_invoices"');
    expect(sql).toContain('OLD."status" = \'DRAFT\' AND NEW."status" = \'ISSUING\'');
    expect(sql).toContain('NOT uoa_billing_invoice_issue_ready(OLD."id")');
    expect(sql).toContain("RAISE EXCEPTION 'invoice is not ready for issuance'");
  });
});
