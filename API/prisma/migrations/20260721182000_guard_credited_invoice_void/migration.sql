-- A credit settlement reference is settlement evidence even when its exact
-- microcredit value rounds to zero minor currency units. Issued invoices with
-- any settlement evidence must be corrected with a new revision, never voided.
CREATE OR REPLACE FUNCTION uoa_guard_billing_invoice_void_settlement()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'VOID' AND OLD."status" <> 'VOID'
    AND (
      EXISTS (
        SELECT 1
        FROM "billing_invoice_credit_settlement_references"
        WHERE "invoice_id" = OLD."id"
      )
      OR EXISTS (
        SELECT 1
        FROM "billing_invoice_payment_events"
        WHERE "invoice_id" = OLD."id"
      )
    )
  THEN
    RAISE EXCEPTION 'settled invoices cannot be voided';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_invoices_settlement_void_guard
BEFORE UPDATE OF "status" ON "billing_invoices"
FOR EACH ROW EXECUTE FUNCTION uoa_guard_billing_invoice_void_settlement();

-- Canonical issue readiness. The application uses this function to project
-- the issue action and the transition trigger uses the same answer. The
-- foundation invoice trigger remains in place as independent defense in depth.
CREATE OR REPLACE FUNCTION uoa_billing_invoice_issue_ready(target_invoice_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT
      invoice."status" = 'DRAFT'
      AND contract."status" = 'ACTIVE'
      AND issuer."active" = true
      AND NOT EXISTS (
        SELECT 1
        FROM "billing_invoices" other_invoice
        WHERE other_invoice."id" <> invoice."id"
          AND other_invoice."org_id" = invoice."org_id"
          AND other_invoice."billing_month" = invoice."billing_month"
          AND other_invoice."currency" = invoice."currency"
          AND other_invoice."status" IN ('ISSUING', 'ISSUED')
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

CREATE OR REPLACE FUNCTION uoa_guard_billing_invoice_issue_readiness()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'ISSUING'
    AND NOT uoa_billing_invoice_issue_ready(OLD."id")
  THEN
    RAISE EXCEPTION 'invoice is not ready for issuance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_invoices_issue_readiness_guard
BEFORE UPDATE OF "status" ON "billing_invoices"
FOR EACH ROW EXECUTE FUNCTION uoa_guard_billing_invoice_issue_readiness();
