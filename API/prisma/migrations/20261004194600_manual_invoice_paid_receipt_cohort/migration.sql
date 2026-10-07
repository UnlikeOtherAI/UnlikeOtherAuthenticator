BEGIN;

-- A manual issuer freezes the exact paid dispatches represented by each
-- usage line. Rounded line totals alone cannot identify a source team or a
-- late receipt after the invoice is issued.
CREATE TABLE billing_invoice_paid_receipts (
  id text PRIMARY KEY,
  invoice_id text NOT NULL REFERENCES billing_invoices(id) ON DELETE RESTRICT,
  service_id text NOT NULL,
  org_id text NOT NULL,
  team_id text NOT NULL,
  billing_month char(7) NOT NULL,
  dispatch_id varchar(160) NOT NULL
    REFERENCES billing_paid_usage_liabilities(dispatch_id) ON DELETE RESTRICT,
  receipt_id varchar(160) NOT NULL,
  rated_microcredits bigint NOT NULL CHECK (rated_microcredits >= 0),
  proof_sha256 char(64) NOT NULL CHECK (proof_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT billing_invoice_paid_receipts_invoice_dispatch_key
    UNIQUE (invoice_id, dispatch_id)
);
CREATE INDEX billing_invoice_paid_receipts_scope_idx
  ON billing_invoice_paid_receipts(service_id, org_id, team_id, billing_month);

CREATE FUNCTION billing_invoice_paid_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE invoice_row record; liability_row record; line_exists boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'invoice paid receipt cohort is immutable' USING ERRCODE = '23514';
  END IF;
  EXECUTE format('SELECT id, org_id, billing_month, status FROM %I.billing_invoices
    WHERE id = $1 FOR UPDATE', TG_TABLE_SCHEMA)
    INTO invoice_row USING NEW.invoice_id;
  EXECUTE format('SELECT dispatch_id, receipt_id, service_id, org_id, team_id,
    billing_month, rated_microcredits, payment_mode
    FROM %I.billing_paid_usage_liabilities WHERE dispatch_id = $1', TG_TABLE_SCHEMA)
    INTO liability_row USING NEW.dispatch_id;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.billing_invoice_lines
    WHERE invoice_id = $1 AND service_id = $2)', TG_TABLE_SCHEMA)
    INTO line_exists USING NEW.invoice_id, NEW.service_id;
  IF invoice_row.id IS NULL OR invoice_row.status <> 'DRAFT' OR NOT line_exists
    OR liability_row.dispatch_id IS NULL
    OR liability_row.payment_mode <> 'PAY_AS_YOU_GO'
    OR liability_row.receipt_id IS DISTINCT FROM NEW.receipt_id
    OR liability_row.service_id IS DISTINCT FROM NEW.service_id
    OR liability_row.org_id IS DISTINCT FROM NEW.org_id
    OR liability_row.team_id IS DISTINCT FROM NEW.team_id
    OR liability_row.billing_month IS DISTINCT FROM NEW.billing_month
    OR liability_row.rated_microcredits IS DISTINCT FROM NEW.rated_microcredits
    OR invoice_row.org_id IS DISTINCT FROM NEW.org_id
    OR invoice_row.billing_month IS DISTINCT FROM NEW.billing_month
  THEN RAISE EXCEPTION 'invoice paid receipt cohort source mismatch'
    USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_invoice_paid_receipt_guard
BEFORE INSERT OR UPDATE OR DELETE ON billing_invoice_paid_receipts
FOR EACH ROW EXECUTE FUNCTION billing_invoice_paid_receipt_guard();

COMMIT;
