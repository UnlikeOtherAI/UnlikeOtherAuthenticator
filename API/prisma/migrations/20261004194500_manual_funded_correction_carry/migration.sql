BEGIN;

-- Supplemental invoices freeze the previous issuer-applied cumulative wallet
-- amount on each settlement reference. Customer cents are the difference of
-- two cumulative rounded amounts; original legal invoices remain immutable.
ALTER TABLE billing_invoice_credit_settlement_references
  ADD COLUMN prior_credits_applied_microcredits bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT billing_invoice_credit_prior_bounds CHECK (
    prior_credits_applied_microcredits >= 0 AND
    prior_credits_applied_microcredits <= credits_applied_microcredits
  );
ALTER TABLE billing_cycle_manual_corrections
  ADD COLUMN credit_delta_minor bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT billing_cycle_manual_correction_credit_delta CHECK (
    credit_delta_minor >= 0 AND credit_delta_minor <= net_delta_minor
  );

CREATE FUNCTION uoa_invoice_credit_carry_valid(target_invoice_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM billing_invoice_credit_settlement_references reference
    JOIN billing_invoices invoice ON invoice.id = reference.invoice_id
    WHERE reference.invoice_id = target_invoice_id AND (
      reference.prior_credits_applied_microcredits < 0 OR
      reference.prior_credits_applied_microcredits > reference.credits_applied_microcredits OR
      (NOT invoice.is_cycle_supplement AND reference.prior_credits_applied_microcredits <> 0) OR
      reference.prior_credits_applied_microcredits IS DISTINCT FROM coalesce((
        SELECT max(previous.credits_applied_microcredits)
        FROM billing_invoice_credit_settlement_references previous
        JOIN billing_invoices issued ON issued.id = previous.invoice_id
        WHERE previous.settlement_id = reference.settlement_id
          AND previous.invoice_id <> reference.invoice_id
          AND issued.status = 'ISSUED'
          AND issued.contract_id = invoice.contract_id
          AND issued.org_id = invoice.org_id
          AND issued.billing_month = invoice.billing_month
          AND issued.revision < invoice.revision
      ), 0)
    )
  );
$$;

CREATE OR REPLACE FUNCTION billing_invoice_line_financial_validate(
  target_schema name, target_invoice_id text
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE totals record; credits record;
BEGIN
  EXECUTE format($sql$
    SELECT invoice.subtotal_minor, invoice.tax_amount_minor,
      invoice.credits_applied_minor, invoice.total_minor,
      count(line.id) AS line_count, count(allocation.line_id) AS allocated_count,
      coalesce(sum(allocation.subscription_minor + allocation.usage_minor), 0) AS subtotal,
      coalesce(sum(allocation.tax_minor), 0) AS tax,
      coalesce(sum(allocation.invoice_credit_minor), 0) AS credit,
      coalesce(sum(allocation.total_minor), 0) AS gross,
      coalesce(sum(allocation.due_minor), 0) AS due,
      count(*) FILTER (WHERE allocation.line_id IS NOT NULL AND
        allocation.invoice_credit_minor <> coalesce(refcredits.amount_minor, 0)) AS bad_line_credits
    FROM %I.billing_invoices AS invoice
    JOIN %I.billing_invoice_lines AS line ON line.invoice_id = invoice.id
    LEFT JOIN %I.billing_invoice_line_financial_allocations AS allocation
      ON allocation.line_id = line.id
    LEFT JOIN (
      SELECT line_id, sum(amount_minor) AS amount_minor
      FROM %I.billing_invoice_line_credit_reference_allocations
      GROUP BY line_id
    ) AS refcredits ON refcredits.line_id = line.id
    WHERE invoice.id = $1
    GROUP BY invoice.id
  $sql$, target_schema, target_schema, target_schema, target_schema)
    INTO totals USING target_invoice_id;
  -- Existing invoices without allocations remain valid legal history; their
  -- ambiguous customer product cycles stay held by the finalizer.
  IF totals IS NULL OR totals.allocated_count = 0 THEN RETURN; END IF;
  IF totals.allocated_count <> totals.line_count OR
    totals.subtotal <> totals.subtotal_minor OR
    totals.tax <> totals.tax_amount_minor OR
    totals.credit <> totals.credits_applied_minor OR
    totals.gross <> totals.total_minor OR
    totals.due <> totals.total_minor - totals.credits_applied_minor OR
    totals.bad_line_credits <> 0 THEN
    RAISE EXCEPTION 'invoice line financial totals mismatch' USING ERRCODE = '23514';
  END IF;

  EXECUTE format($sql$
    WITH ordered AS (
      SELECT reference.id,
        (reference.credits_applied_microcredits -
          reference.prior_credits_applied_microcredits)::numeric AS microcredits,
        allocation.amount_minor,
        (SELECT coalesce(sum(prior_credits_applied_microcredits), 0)::numeric
          FROM %I.billing_invoice_credit_settlement_references
          WHERE invoice_id = $1) +
        sum((reference.credits_applied_microcredits -
          reference.prior_credits_applied_microcredits)::numeric) OVER (
          ORDER BY reference.service_id COLLATE "C", reference.settlement_id COLLATE "C", reference.id COLLATE "C"
        ) AS cumulative
      FROM %I.billing_invoice_credit_settlement_references AS reference
      LEFT JOIN %I.billing_invoice_line_credit_reference_allocations AS allocation
        ON allocation.reference_id = reference.id
      WHERE reference.invoice_id = $1
    )
    SELECT count(*) AS reference_count, count(amount_minor) AS allocated_count,
      count(*) FILTER (WHERE amount_minor IS NOT NULL AND amount_minor::numeric <>
        floor((cumulative + 5000000) / 10000000) -
        floor((cumulative - microcredits + 5000000) / 10000000)) AS bad_rounding
    FROM ordered
  $sql$, target_schema, target_schema, target_schema)
    INTO credits USING target_invoice_id;
  IF credits.reference_count <> credits.allocated_count OR credits.bad_rounding <> 0 THEN
    RAISE EXCEPTION 'invoice credit reference allocation mismatch' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION uoa_billing_invoice_is_bound_supplement(target_invoice_id text)
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
      AND supplement.credits_applied_minor = correction.credit_delta_minor
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
      AND (
        (SELECT floor((COALESCE(sum(reference."credits_applied_microcredits"), 0)::numeric
          + 5000000) / 10000000) -
          floor((COALESCE(sum(reference."prior_credits_applied_microcredits"), 0)::numeric
          + 5000000) / 10000000)
          FROM "billing_invoice_credit_settlement_references" reference
          WHERE reference."invoice_id" = invoice."id")
      ) = invoice."credits_applied_minor"::numeric
      AND uoa_invoice_credit_carry_valid(invoice."id")
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
          AND NOT (invoice."is_cycle_supplement" AND other_invoice."status" = 'ISSUED'
            AND other_invoice."contract_id" = invoice."contract_id"
            AND other_invoice."billing_month" = invoice."billing_month"
            AND other_reference."credits_applied_microcredits" =
              reference."prior_credits_applied_microcredits")
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

CREATE OR REPLACE FUNCTION uoa_guard_billing_invoice()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE contract_status "BillingOrganisationContractStatus"; version_currency CHAR(3); version_month CHAR(7); latest_revision INTEGER;
  invoice_credit_microcredits NUMERIC; prior_credit_microcredits NUMERIC; expected_credit_minor NUMERIC; collector_settlement_id TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('uoa-contract:' || CASE WHEN TG_OP = 'DELETE' THEN OLD."contract_id" ELSE NEW."contract_id" END, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('uoa-contract-version:' || CASE WHEN TG_OP = 'DELETE' THEN OLD."contract_version_id" ELSE NEW."contract_version_id" END, 0));
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'issued invoices cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('uoa-invoice-revision:' || NEW."contract_id" || ':' || NEW."billing_month", 0)
    );
    SELECT max("revision") INTO latest_revision
    FROM "billing_invoices"
    WHERE "contract_id" = NEW."contract_id" AND "billing_month" = NEW."billing_month";
    IF NEW."revision" <> COALESCE(latest_revision, 0) + 1 THEN
      RAISE EXCEPTION 'invoice revision must be contiguous';
    END IF;
  END IF;
  SELECT contract."status", version."currency", version."effective_from_month"
    INTO contract_status, version_currency, version_month
  FROM "billing_organisation_contracts" contract
  JOIN "billing_organisation_contract_versions" version
    ON version."contract_id" = contract."id" AND version."id" = NEW."contract_version_id"
  JOIN "billing_organisation_invoice_profiles" buyer
    ON buyer."id" = NEW."buyer_profile_id" AND buyer."org_id" = NEW."org_id"
  WHERE contract."id" = NEW."contract_id" AND contract."org_id" = NEW."org_id";
  IF NOT FOUND OR NEW."currency" <> version_currency OR NEW."billing_month" < version_month
    OR EXISTS (SELECT 1 FROM "billing_organisation_contract_versions" other
      WHERE other."contract_id" = NEW."contract_id" AND other."effective_from_month" <= NEW."billing_month"
        AND other."effective_from_month" > version_month) THEN
    RAISE EXCEPTION 'invoice contract scope is incoherent' USING ERRCODE = '23503';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (
      NEW."org_id" IS DISTINCT FROM OLD."org_id" OR NEW."contract_id" IS DISTINCT FROM OLD."contract_id"
      OR NEW."contract_version_id" IS DISTINCT FROM OLD."contract_version_id"
      OR NEW."issuer_profile_id" IS DISTINCT FROM OLD."issuer_profile_id"
      OR NEW."buyer_profile_id" IS DISTINCT FROM OLD."buyer_profile_id"
      OR NEW."billing_month" IS DISTINCT FROM OLD."billing_month" OR NEW."revision" IS DISTINCT FROM OLD."revision"
      OR NEW."currency" IS DISTINCT FROM OLD."currency"
      OR NEW."subtotal_minor" IS DISTINCT FROM OLD."subtotal_minor" OR NEW."tax_amount_minor" IS DISTINCT FROM OLD."tax_amount_minor"
      OR NEW."total_minor" IS DISTINCT FROM OLD."total_minor"
      OR NEW."credits_applied_minor" IS DISTINCT FROM OLD."credits_applied_minor"
      OR NEW."issuer_snapshot" IS DISTINCT FROM OLD."issuer_snapshot"
      OR NEW."buyer_snapshot" IS DISTINCT FROM OLD."buyer_snapshot" OR NEW."calculation_digest" IS DISTINCT FROM OLD."calculation_digest"
      OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
      OR NEW."created_by_email" IS DISTINCT FROM OLD."created_by_email" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    ) THEN RAISE EXCEPTION 'calculated invoice commercial fields are immutable'; END IF;
    IF OLD."status" IN ('ISSUING', 'ISSUED', 'VOID') AND (
      NEW."invoice_number" IS DISTINCT FROM OLD."invoice_number"
      OR NEW."issue_date" IS DISTINCT FROM OLD."issue_date"
      OR NEW."due_date" IS DISTINCT FROM OLD."due_date"
    ) THEN RAISE EXCEPTION 'issued invoice identity and dates are immutable'; END IF;
    IF OLD."status" = 'ISSUED' AND (
      NEW."pdf_object_key" IS DISTINCT FROM OLD."pdf_object_key"
      OR NEW."pdf_sha256" IS DISTINCT FROM OLD."pdf_sha256"
      OR NEW."pdf_template_version" IS DISTINCT FROM OLD."pdf_template_version"
      OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at"
    ) THEN RAISE EXCEPTION 'issued invoice artifacts are immutable'; END IF;
    IF (OLD."status" = 'DRAFT' AND NEW."status" NOT IN ('DRAFT', 'ISSUING'))
      OR (OLD."status" = 'ISSUING' AND NEW."status" NOT IN ('ISSUING', 'ISSUED', 'VOID'))
      OR (OLD."status" = 'ISSUED' AND NEW."status" NOT IN ('ISSUED', 'VOID'))
      OR OLD."status" = 'VOID'
    THEN RAISE EXCEPTION 'invalid invoice status transition'; END IF;
  END IF;
  IF NEW."status" = 'ISSUING' AND (TG_OP = 'INSERT' OR OLD."status" <> 'ISSUING') THEN
    FOR collector_settlement_id IN
      SELECT "settlement_id" FROM "billing_invoice_credit_settlement_references"
      WHERE "invoice_id" = NEW."id" ORDER BY "settlement_id"
    LOOP
      PERFORM pg_advisory_xact_lock(
        hashtextextended('uoa-credit-collector:' || collector_settlement_id, 0)
      );
    END LOOP;
    SELECT COALESCE(sum("credits_applied_microcredits"), 0),
      COALESCE(sum("prior_credits_applied_microcredits"), 0)
      INTO invoice_credit_microcredits, prior_credit_microcredits
    FROM "billing_invoice_credit_settlement_references"
    WHERE "invoice_id" = NEW."id";
    expected_credit_minor := floor((invoice_credit_microcredits + 5000000) / 10000000)
      - floor((prior_credit_microcredits + 5000000) / 10000000);
    IF contract_status <> 'ACTIVE'
      OR NOT EXISTS (SELECT 1 FROM "billing_invoice_issuer_profiles" WHERE "id" = NEW."issuer_profile_id" AND "active" = true)
      OR NOT EXISTS (SELECT 1 FROM "billing_invoice_lines" WHERE "invoice_id" = NEW."id")
      OR EXISTS ((SELECT "service_id" FROM "billing_contract_service_terms" WHERE "contract_version_id" = NEW."contract_version_id")
        EXCEPT (SELECT "service_id" FROM "billing_invoice_lines" WHERE "invoice_id" = NEW."id"))
      OR EXISTS ((SELECT "service_id" FROM "billing_invoice_lines" WHERE "invoice_id" = NEW."id")
        EXCEPT (SELECT "service_id" FROM "billing_contract_service_terms" WHERE "contract_version_id" = NEW."contract_version_id"))
      OR EXISTS ((SELECT "service_id" FROM "billing_invoice_lines" WHERE "invoice_id" = NEW."id")
        EXCEPT (SELECT "service_id" FROM "billing_invoice_metering_references" WHERE "invoice_id" = NEW."id"))
      OR EXISTS ((SELECT "service_id" FROM "billing_invoice_metering_references" WHERE "invoice_id" = NEW."id")
        EXCEPT (SELECT "service_id" FROM "billing_invoice_lines" WHERE "invoice_id" = NEW."id"))
      OR (SELECT COALESCE(sum("amount_minor"), 0) FROM "billing_invoice_lines" WHERE "invoice_id" = NEW."id") <> NEW."subtotal_minor"
      OR expected_credit_minor <> NEW."credits_applied_minor"::numeric
      OR NOT uoa_invoice_credit_carry_valid(NEW."id")
      OR EXISTS (
        SELECT 1
        FROM "billing_invoice_credit_settlement_references" reference
        JOIN "billing_credit_usage_settlements" settlement
          ON settlement."id" = reference."settlement_id"
        JOIN "billing_credit_usage_settlement_adjustments" adjustment
          ON adjustment."id" = reference."adjustment_id"
        WHERE reference."invoice_id" = NEW."id"
          AND (
            settlement."status" <> 'APPLIED'
            OR adjustment."settlement_id" IS DISTINCT FROM settlement."id"
            OR adjustment."cumulative_credits_consumed_microcredits"
              IS DISTINCT FROM reference."credits_applied_microcredits"
            OR adjustment."id" IS DISTINCT FROM (
              SELECT latest."id"
              FROM "billing_credit_usage_settlement_adjustments" latest
              WHERE latest."settlement_id" = settlement."id"
              ORDER BY latest."sequence" DESC
              LIMIT 1
            )
          )
      )
      OR EXISTS (
        SELECT 1
        FROM "billing_invoice_credit_settlement_references" reference
        JOIN "billing_credit_invoice_lines" stripe_line
          ON stripe_line."settlement_id" = reference."settlement_id"
         AND stripe_line."status" IN ('CREATING', 'APPLIED')
        WHERE reference."invoice_id" = NEW."id"
      )
      OR EXISTS (
        SELECT 1
        FROM "billing_invoice_credit_settlement_references" current_reference
        JOIN "billing_invoice_credit_settlement_references" other_reference
          ON other_reference."settlement_id" = current_reference."settlement_id"
         AND other_reference."invoice_id" <> current_reference."invoice_id"
        JOIN "billing_invoices" other_invoice ON other_invoice."id" = other_reference."invoice_id"
        WHERE current_reference."invoice_id" = NEW."id"
          AND other_invoice."status" IN ('ISSUING', 'ISSUED')
          AND NOT (NEW."is_cycle_supplement" AND other_invoice."status" = 'ISSUED'
            AND other_invoice."contract_id" = NEW."contract_id"
            AND other_invoice."billing_month" = NEW."billing_month"
            AND other_reference."credits_applied_microcredits" =
              current_reference."prior_credits_applied_microcredits")
      )
    THEN RAISE EXCEPTION 'invoice is not ready for issuance'; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."status" = 'VOID' AND OLD."status" <> 'VOID'
    AND EXISTS (SELECT 1 FROM "billing_invoice_payment_events" WHERE "invoice_id" = NEW."id")
  THEN RAISE EXCEPTION 'settled invoices cannot be voided'; END IF;
  RETURN NEW;
END;
$$;

COMMIT;
