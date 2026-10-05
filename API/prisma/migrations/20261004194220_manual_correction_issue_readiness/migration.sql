BEGIN;

-- A second issued invoice in the same month is permitted only for an
-- immutable correction binding to an already issued original service line.
CREATE FUNCTION uoa_billing_invoice_is_bound_supplement(target_invoice_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM billing_cycle_manual_corrections correction
    JOIN billing_customer_cycles pending
      ON pending.id = correction.pending_cycle_id
    JOIN billing_customer_cycles original_cycle
      ON original_cycle.id = correction.original_cycle_id
    JOIN billing_invoice_lines original_line
      ON original_line.id = correction.original_line_id
    JOIN billing_invoices original_invoice
      ON original_invoice.id = original_line.invoice_id
    JOIN billing_invoices supplement
      ON supplement.id = correction.supplement_invoice_id
    JOIN billing_invoice_lines supplement_line
      ON supplement_line.invoice_id = supplement.id
    WHERE supplement.id = target_invoice_id
      AND correction.kind = 'debit'
      AND original_invoice.status = 'ISSUED'
      AND original_invoice.voided_at IS NULL
      AND original_invoice.id <> supplement.id
      AND original_invoice.org_id = supplement.org_id
      AND original_invoice.billing_month = supplement.billing_month
      AND original_invoice.currency = supplement.currency
      AND pending.org_id = supplement.org_id
      AND pending.billing_month = supplement.billing_month
      AND pending.state = 'pending_reconciliation'
      AND original_cycle.state IN ('finalized', 'adjusted')
      AND original_cycle.org_id = supplement.org_id
      AND original_cycle.billing_month = supplement.billing_month
      AND supplement_line.service_id = original_line.service_id
      AND supplement.subtotal_minor = correction.net_delta_minor
      AND supplement.tax_amount_minor = correction.tax_delta_minor
      AND supplement.total_minor = correction.net_delta_minor + correction.tax_delta_minor
      AND supplement.credits_applied_minor = 0
  );
$$;

CREATE OR REPLACE FUNCTION uoa_billing_invoice_issue_ready(target_invoice_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT
      invoice."status" = 'DRAFT'
      AND contract."status" = 'ACTIVE'
      AND issuer."active" = true
      AND (
        NOT EXISTS (
          SELECT 1
          FROM "billing_invoices" other_invoice
          WHERE other_invoice."id" <> invoice."id"
            AND other_invoice."org_id" = invoice."org_id"
            AND other_invoice."billing_month" = invoice."billing_month"
            AND other_invoice."currency" = invoice."currency"
            AND other_invoice."status" IN ('ISSUING', 'ISSUED')
        ) OR uoa_billing_invoice_is_bound_supplement(invoice."id")
      )
      AND EXISTS (
        SELECT 1 FROM "billing_invoice_lines"
        WHERE "invoice_id" = invoice."id"
      )
      AND NOT EXISTS (
        (SELECT "service_id" FROM "billing_contract_service_terms"
          WHERE "contract_version_id" = invoice."contract_version_id")
        EXCEPT
        (SELECT "service_id" FROM "billing_invoice_lines"
          WHERE "invoice_id" = invoice."id")
      )
      AND NOT EXISTS (
        (SELECT "service_id" FROM "billing_invoice_lines"
          WHERE "invoice_id" = invoice."id")
        EXCEPT
        (SELECT "service_id" FROM "billing_contract_service_terms"
          WHERE "contract_version_id" = invoice."contract_version_id")
      )
      AND NOT EXISTS (
        (SELECT "service_id" FROM "billing_invoice_lines"
          WHERE "invoice_id" = invoice."id")
        EXCEPT
        (SELECT "service_id" FROM "billing_invoice_metering_references"
          WHERE "invoice_id" = invoice."id")
      )
      AND NOT EXISTS (
        (SELECT "service_id" FROM "billing_invoice_metering_references"
          WHERE "invoice_id" = invoice."id")
        EXCEPT
        (SELECT "service_id" FROM "billing_invoice_lines"
          WHERE "invoice_id" = invoice."id")
      )
      AND (
        SELECT COALESCE(sum(line."amount_minor"), 0)
        FROM "billing_invoice_lines" line
        WHERE line."invoice_id" = invoice."id"
      ) = invoice."subtotal_minor"
      AND floor((
        (SELECT COALESCE(sum(reference."credits_applied_microcredits"), 0)
          FROM "billing_invoice_credit_settlement_references" reference
          WHERE reference."invoice_id" = invoice."id")::numeric
        + 5000000
      ) / 10000000) = invoice."credits_applied_minor"::numeric
      AND NOT EXISTS (
        SELECT 1
        FROM "billing_invoice_credit_settlement_references" reference
        LEFT JOIN "billing_credit_usage_settlements" settlement
          ON settlement."id" = reference."settlement_id"
        LEFT JOIN "billing_credit_usage_settlement_adjustments" adjustment
          ON adjustment."id" = reference."adjustment_id"
        LEFT JOIN "billing_invoice_lines" line
          ON line."invoice_id" = reference."invoice_id"
         AND line."service_id" = reference."service_id"
        WHERE reference."invoice_id" = invoice."id"
          AND (
            settlement."id" IS NULL
            OR settlement."status" <> 'APPLIED'
            OR settlement."service_id" IS DISTINCT FROM reference."service_id"
            OR settlement."cumulative_credits_consumed_microcredits"
              IS DISTINCT FROM reference."credits_applied_microcredits"
            OR adjustment."id" IS NULL
            OR adjustment."settlement_id" IS DISTINCT FROM settlement."id"
            OR adjustment."service_id" IS DISTINCT FROM reference."service_id"
            OR adjustment."cumulative_credits_consumed_microcredits"
              IS DISTINCT FROM reference."credits_applied_microcredits"
            OR adjustment."id" IS DISTINCT FROM (
              SELECT latest."id"
              FROM "billing_credit_usage_settlement_adjustments" latest
              WHERE latest."settlement_id" = reference."settlement_id"
              ORDER BY latest."sequence" DESC
              LIMIT 1
            )
            OR line."id" IS NULL
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "billing_invoice_credit_settlement_references" reference
        JOIN "billing_credit_invoice_lines" stripe_line
          ON stripe_line."settlement_id" = reference."settlement_id"
         AND stripe_line."status" IN ('CREATING', 'APPLIED')
        WHERE reference."invoice_id" = invoice."id"
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "billing_invoice_credit_settlement_references" reference
        JOIN "billing_invoice_credit_settlement_references" other_reference
          ON other_reference."settlement_id" = reference."settlement_id"
         AND other_reference."invoice_id" <> reference."invoice_id"
        JOIN "billing_invoices" other_invoice
          ON other_invoice."id" = other_reference."invoice_id"
         AND other_invoice."status" IN ('ISSUING', 'ISSUED')
        WHERE reference."invoice_id" = invoice."id"
      )
    FROM "billing_invoices" invoice
    JOIN "billing_organisation_contracts" contract
      ON contract."id" = invoice."contract_id"
     AND contract."org_id" = invoice."org_id"
    JOIN "billing_invoice_issuer_profiles" issuer
      ON issuer."id" = invoice."issuer_profile_id"
    WHERE invoice."id" = target_invoice_id
  ), false);
$$;

COMMIT;
