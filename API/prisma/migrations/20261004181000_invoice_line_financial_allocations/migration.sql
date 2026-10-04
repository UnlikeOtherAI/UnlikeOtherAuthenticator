BEGIN;

-- Invoice totals remain gross. Credits reduce due, never the recorded gross
-- invoice total. An issuer must explicitly allocate tax and usage credits to
-- each legal service line; no customer cycle may divide them proportionally.
CREATE TABLE billing_invoice_line_financial_allocations (
  line_id text PRIMARY KEY REFERENCES billing_invoice_lines(id) ON DELETE RESTRICT,
  invoice_id text NOT NULL REFERENCES billing_invoices(id) ON DELETE RESTRICT,
  service_id text NOT NULL REFERENCES billing_services(id) ON DELETE RESTRICT,
  billing_month char(7) NOT NULL,
  subscription_minor bigint NOT NULL,
  usage_minor bigint NOT NULL,
  tax_minor bigint NOT NULL,
  invoice_credit_minor bigint NOT NULL,
  total_minor bigint NOT NULL,
  due_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  calculation_digest char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_invoice_line_financial_nonnegative CHECK (
    subscription_minor >= 0 AND usage_minor >= 0 AND tax_minor >= 0 AND
    invoice_credit_minor >= 0 AND total_minor >= 0 AND due_minor >= 0 AND
    invoice_credit_minor <= usage_minor AND
    total_minor = subscription_minor + usage_minor + tax_minor AND
    due_minor = total_minor - invoice_credit_minor
  ),
  CONSTRAINT billing_invoice_line_financial_month CHECK (
    billing_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  ),
  CONSTRAINT billing_invoice_line_financial_digest CHECK (
    calculation_digest ~ '^[a-f0-9]{64}$'
  )
);
CREATE INDEX billing_invoice_line_financial_invoice_idx
  ON billing_invoice_line_financial_allocations(invoice_id);
CREATE INDEX billing_invoice_line_financial_service_month_idx
  ON billing_invoice_line_financial_allocations(service_id, billing_month);

CREATE FUNCTION billing_invoice_line_financial_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE source record;
BEGIN
  EXECUTE format('SELECT line.invoice_id, line.service_id, line.amount_minor,
    line.currency, invoice.billing_month, invoice.calculation_digest,
    invoice.status FROM %I.billing_invoice_lines AS line
    JOIN %I.billing_invoices AS invoice ON invoice.id = line.invoice_id
    WHERE line.id = $1', TG_TABLE_SCHEMA, TG_TABLE_SCHEMA)
    INTO source USING NEW.line_id;
  IF source IS NULL OR source.invoice_id <> NEW.invoice_id OR
    source.service_id <> NEW.service_id OR
    source.amount_minor <> NEW.subscription_minor + NEW.usage_minor OR
    source.currency <> NEW.currency OR
    source.billing_month <> NEW.billing_month OR
    source.calculation_digest <> NEW.calculation_digest OR
    source.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'invoice line financial source mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION billing_invoice_line_financial_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'invoice line financial allocation is immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER billing_invoice_line_financial_insert_guard
BEFORE INSERT ON billing_invoice_line_financial_allocations
FOR EACH ROW EXECUTE FUNCTION billing_invoice_line_financial_insert_guard();
CREATE TRIGGER billing_invoice_line_financial_immutable
BEFORE UPDATE OR DELETE ON billing_invoice_line_financial_allocations
FOR EACH ROW EXECUTE FUNCTION billing_invoice_line_financial_immutable();

CREATE FUNCTION billing_invoice_line_financial_validate(
  target_schema name, target_invoice_id text
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE totals record;
BEGIN
  EXECUTE format($sql$
    SELECT invoice.subtotal_minor, invoice.tax_amount_minor,
      invoice.credits_applied_minor, invoice.total_minor,
      count(line.id) AS line_count, count(allocation.line_id) AS allocated_count,
      coalesce(sum(allocation.subscription_minor + allocation.usage_minor), 0) AS subtotal,
      coalesce(sum(allocation.tax_minor), 0) AS tax,
      coalesce(sum(allocation.invoice_credit_minor), 0) AS credit,
      coalesce(sum(allocation.total_minor), 0) AS gross,
      coalesce(sum(allocation.due_minor), 0) AS due
    FROM %I.billing_invoices AS invoice
    JOIN %I.billing_invoice_lines AS line ON line.invoice_id = invoice.id
    LEFT JOIN %I.billing_invoice_line_financial_allocations AS allocation
      ON allocation.line_id = line.id
    WHERE invoice.id = $1
    GROUP BY invoice.id
  $sql$, target_schema, target_schema, target_schema)
    INTO totals USING target_invoice_id;
  -- Old invoices without these explicit allocations remain readable. Their
  -- ambiguous multi-line/tax/credit cycles stay held by the producer.
  IF totals IS NULL OR totals.allocated_count = 0 THEN RETURN; END IF;
  IF totals.allocated_count <> totals.line_count OR
    totals.subtotal <> totals.subtotal_minor OR
    totals.tax <> totals.tax_amount_minor OR
    totals.credit <> totals.credits_applied_minor OR
    totals.gross <> totals.total_minor OR
    totals.due <> totals.total_minor - totals.credits_applied_minor THEN
    RAISE EXCEPTION 'invoice line financial totals mismatch' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION billing_invoice_line_financial_validate_deferred() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  EXECUTE format('SELECT %I.billing_invoice_line_financial_validate($1, $2)', TG_TABLE_SCHEMA)
    USING TG_TABLE_SCHEMA, NEW.invoice_id;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER billing_invoice_line_financial_complete
AFTER INSERT ON billing_invoice_line_financial_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION billing_invoice_line_financial_validate_deferred();

CREATE FUNCTION billing_invoice_line_financial_issue_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status IN ('ISSUING', 'ISSUED') AND
    NEW.status IS DISTINCT FROM OLD.status THEN
    EXECUTE format('SELECT %I.billing_invoice_line_financial_validate($1, $2)', TG_TABLE_SCHEMA)
      USING TG_TABLE_SCHEMA, NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_invoice_line_financial_issue_guard
BEFORE UPDATE OF status ON billing_invoices
FOR EACH ROW EXECUTE FUNCTION billing_invoice_line_financial_issue_guard();

GRANT SELECT, INSERT ON billing_invoice_line_financial_allocations TO uoa_app, uoa_admin;

COMMIT;
