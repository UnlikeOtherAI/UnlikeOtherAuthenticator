BEGIN;

-- A whole-invoice credit is rounded once. Its settled microcredit references
-- are assigned deterministically in service/settlement order, so the last
-- fractional cent is preserved without shifting funded usage to a seat fee.
CREATE TABLE billing_invoice_line_credit_reference_allocations (
  reference_id text PRIMARY KEY
    REFERENCES billing_invoice_credit_settlement_references(id) ON DELETE RESTRICT,
  invoice_id text NOT NULL REFERENCES billing_invoices(id) ON DELETE RESTRICT,
  line_id text NOT NULL REFERENCES billing_invoice_lines(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_invoice_line_credit_refs_invoice_line_idx
  ON billing_invoice_line_credit_reference_allocations(invoice_id, line_id);

CREATE FUNCTION billing_invoice_line_credit_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE source record;
BEGIN
  EXECUTE format($sql$
    SELECT reference.invoice_id, reference.service_id, line.service_id AS line_service_id,
      line.invoice_id AS line_invoice_id, invoice.status
    FROM %I.billing_invoice_credit_settlement_references AS reference
    JOIN %I.billing_invoice_lines AS line ON line.id = $2
    JOIN %I.billing_invoices AS invoice ON invoice.id = reference.invoice_id
    WHERE reference.id = $1
  $sql$, TG_TABLE_SCHEMA, TG_TABLE_SCHEMA, TG_TABLE_SCHEMA)
    INTO source USING NEW.reference_id, NEW.line_id;
  IF source IS NULL OR source.invoice_id <> NEW.invoice_id OR
    source.line_invoice_id <> NEW.invoice_id OR
    source.line_service_id <> source.service_id OR source.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'invoice credit reference line mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_invoice_line_credit_insert_guard
BEFORE INSERT ON billing_invoice_line_credit_reference_allocations
FOR EACH ROW EXECUTE FUNCTION billing_invoice_line_credit_insert_guard();
CREATE TRIGGER billing_invoice_line_credit_immutable
BEFORE UPDATE OR DELETE ON billing_invoice_line_credit_reference_allocations
FOR EACH ROW EXECUTE FUNCTION billing_invoice_line_financial_immutable();

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
      SELECT reference.id, reference.credits_applied_microcredits::numeric AS microcredits,
        allocation.amount_minor,
        sum(reference.credits_applied_microcredits::numeric) OVER (
          ORDER BY reference.service_id, reference.settlement_id, reference.id
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
  $sql$, target_schema, target_schema)
    INTO credits USING target_invoice_id;
  IF credits.reference_count <> credits.allocated_count OR credits.bad_rounding <> 0 THEN
    RAISE EXCEPTION 'invoice credit reference allocation mismatch' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE CONSTRAINT TRIGGER billing_invoice_line_credit_complete
AFTER INSERT ON billing_invoice_line_credit_reference_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION billing_invoice_line_financial_validate_deferred();

GRANT SELECT, INSERT ON billing_invoice_line_credit_reference_allocations
  TO uoa_app, uoa_admin;

COMMIT;
