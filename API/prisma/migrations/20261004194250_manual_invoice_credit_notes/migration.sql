BEGIN;

CREATE TABLE billing_manual_credit_notes (
  id text PRIMARY KEY,
  original_invoice_id text NOT NULL UNIQUE REFERENCES billing_invoices(id) ON DELETE RESTRICT,
  original_cycle_id text NOT NULL UNIQUE REFERENCES billing_customer_cycles(id) ON DELETE RESTRICT,
  issuer_profile_id text NOT NULL REFERENCES billing_invoice_issuer_profiles(id) ON DELETE RESTRICT,
  org_id text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  service_id text NOT NULL REFERENCES billing_services(id) ON DELETE RESTRICT,
  billing_month char(7) NOT NULL,
  currency char(3) NOT NULL,
  net_credit_minor bigint NOT NULL CHECK (net_credit_minor > 0),
  tax_credit_minor bigint NOT NULL CHECK (tax_credit_minor >= 0),
  total_credit_minor bigint NOT NULL,
  tax_treatment varchar(32) NOT NULL,
  tax_rate_bps integer NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  tax_legal_basis varchar(500) NOT NULL CHECK (length(trim(tax_legal_basis)) > 0),
  issuer_snapshot jsonb NOT NULL,
  buyer_snapshot jsonb NOT NULL,
  original_source_digest char(64) NOT NULL,
  reason varchar(500) NOT NULL CHECK (length(trim(reason)) > 0),
  evidence_digest char(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ISSUING', 'ISSUED')),
  credit_note_number varchar(90) UNIQUE,
  issue_date timestamptz,
  pdf_object_key varchar(1024),
  pdf_sha256 char(64),
  issued_at timestamptz,
  created_by_user_id text,
  created_by_email varchar(320) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_manual_credit_note_total_check
    CHECK (total_credit_minor = net_credit_minor + tax_credit_minor),
  CONSTRAINT billing_manual_credit_note_tax_check CHECK (
    (tax_treatment = 'NO_TAX_CHARGED' AND tax_rate_bps = 0) OR
    (tax_treatment = 'STANDARD_RATE' AND tax_rate_bps > 0)
  ),
  CONSTRAINT billing_manual_credit_note_issue_check CHECK (
    (status = 'PENDING' AND credit_note_number IS NULL AND issue_date IS NULL
      AND pdf_object_key IS NULL AND pdf_sha256 IS NULL AND issued_at IS NULL) OR
    (status = 'ISSUING' AND credit_note_number IS NOT NULL AND issue_date IS NOT NULL
      AND pdf_object_key IS NULL AND pdf_sha256 IS NULL AND issued_at IS NULL) OR
    (status = 'ISSUED' AND credit_note_number IS NOT NULL AND issue_date IS NOT NULL
      AND pdf_object_key IS NOT NULL AND pdf_sha256 IS NOT NULL AND issued_at IS NOT NULL)
  )
);
CREATE INDEX billing_manual_credit_notes_status_created_idx
  ON billing_manual_credit_notes(status, created_at);

CREATE FUNCTION billing_manual_credit_note_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE source_invoice record; source_cycle record; source_allocation record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'manual credit notes are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['status', 'credit_note_number', 'issue_date',
      'pdf_object_key', 'pdf_sha256', 'issued_at', 'updated_at']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['status', 'credit_note_number', 'issue_date',
      'pdf_object_key', 'pdf_sha256', 'issued_at', 'updated_at']) OR
      (OLD.status = 'PENDING' AND NEW.status NOT IN ('PENDING', 'ISSUING')) OR
      (OLD.status = 'ISSUING' AND NEW.status NOT IN ('ISSUING', 'ISSUED')) OR
      OLD.status = 'ISSUED' OR
      (OLD.status = 'ISSUING' AND (NEW.credit_note_number IS DISTINCT FROM
        OLD.credit_note_number OR NEW.issue_date IS DISTINCT FROM OLD.issue_date))
    THEN RAISE EXCEPTION 'manual credit note source is immutable' USING ERRCODE = '23514'; END IF;
  ELSE
    EXECUTE format('SELECT org_id, billing_month, currency, issuer_profile_id,
      issuer_snapshot, buyer_snapshot, status, subtotal_minor, tax_amount_minor,
      total_minor, credits_applied_minor, voided_at FROM %I.billing_invoices
      WHERE id = $1', TG_TABLE_SCHEMA)
      INTO source_invoice USING NEW.original_invoice_id;
    EXECUTE format('SELECT org_id, service_id, billing_month, team_id, state
      FROM %I.billing_customer_cycles WHERE id = $1', TG_TABLE_SCHEMA)
      INTO source_cycle USING NEW.original_cycle_id;
    EXECUTE format('SELECT count(*) AS count, min(service_id) AS service_id,
      sum(subscription_minor + usage_minor) AS net_minor,
      sum(tax_minor) AS tax_minor, sum(invoice_credit_minor) AS credit_minor
      FROM %I.billing_invoice_line_financial_allocations
      WHERE invoice_id = $1', TG_TABLE_SCHEMA)
      INTO source_allocation USING NEW.original_invoice_id;
    IF source_invoice.status <> 'ISSUED' OR source_invoice.voided_at IS NOT NULL OR
      source_invoice.org_id <> NEW.org_id OR source_invoice.billing_month <> NEW.billing_month OR
      source_invoice.currency <> NEW.currency OR
      source_invoice.issuer_profile_id <> NEW.issuer_profile_id OR
      source_invoice.issuer_snapshot <> NEW.issuer_snapshot OR
      source_invoice.buyer_snapshot <> NEW.buyer_snapshot OR
      source_invoice.subtotal_minor <> NEW.net_credit_minor OR
      source_invoice.tax_amount_minor <> NEW.tax_credit_minor OR
      source_invoice.total_minor <> NEW.total_credit_minor OR
      source_invoice.credits_applied_minor <> 0 OR
      source_allocation.count <> 1 OR source_allocation.service_id <> NEW.service_id OR
      source_allocation.net_minor <> NEW.net_credit_minor OR
      source_allocation.tax_minor <> NEW.tax_credit_minor OR
      source_allocation.credit_minor <> 0 OR
      source_cycle.org_id <> NEW.org_id OR source_cycle.service_id <> NEW.service_id OR
      source_cycle.billing_month <> NEW.billing_month OR source_cycle.team_id IS NOT NULL OR
      source_cycle.state NOT IN ('finalized', 'adjusted') THEN
      RAISE EXCEPTION 'credit note does not match issued source' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_manual_credit_note_guard
BEFORE INSERT OR UPDATE OR DELETE ON billing_manual_credit_notes
FOR EACH ROW EXECUTE FUNCTION billing_manual_credit_note_guard();

-- Issuance and subsequent payment/refund events share the invoice's durable
-- generation-fenced reconciliation queue. A failed post-issue projection is
-- retried without issuing a second legal credit note.
CREATE FUNCTION billing_enqueue_manual_credit_note() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status = 'ISSUED' AND OLD.status IS DISTINCT FROM NEW.status THEN
    EXECUTE format('SELECT %I.billing_enqueue_manual_cycle_source($1, $2)',
      TG_TABLE_SCHEMA) USING TG_TABLE_SCHEMA, NEW.original_invoice_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_manual_credit_note_enqueue
AFTER UPDATE OF status ON billing_manual_credit_notes
FOR EACH ROW EXECUTE FUNCTION billing_enqueue_manual_credit_note();

GRANT SELECT, INSERT, UPDATE ON billing_manual_credit_notes TO uoa_app, uoa_admin;

COMMIT;
