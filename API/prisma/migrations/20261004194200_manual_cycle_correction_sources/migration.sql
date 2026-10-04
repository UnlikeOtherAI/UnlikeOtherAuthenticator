BEGIN;

-- Historical issued invoices retain null policy evidence. Their corrections
-- hold until independently reviewed; a zero recorded tax is not itself proof
-- of the original applicable treatment.
ALTER TABLE billing_invoices
  ADD COLUMN tax_treatment varchar(32),
  ADD COLUMN tax_rate_bps integer,
  ADD COLUMN tax_legal_basis varchar(500),
  ADD CONSTRAINT billing_invoice_tax_policy_complete CHECK (
    (tax_treatment IS NULL AND tax_rate_bps IS NULL AND tax_legal_basis IS NULL) OR
    (tax_treatment = 'NO_TAX_CHARGED' AND tax_rate_bps = 0 AND
      length(trim(tax_legal_basis)) > 0) OR
    (tax_treatment = 'STANDARD_RATE' AND tax_rate_bps BETWEEN 1 AND 10000 AND
      length(trim(tax_legal_basis)) > 0)
  );


CREATE TABLE billing_cycle_manual_corrections (
  id text PRIMARY KEY,
  pending_cycle_id text NOT NULL UNIQUE
    REFERENCES billing_customer_cycles(id) ON DELETE RESTRICT,
  original_cycle_id text NOT NULL
    REFERENCES billing_customer_cycles(id) ON DELETE RESTRICT,
  supplement_invoice_id text UNIQUE
    REFERENCES billing_invoices(id) ON DELETE RESTRICT,
  kind varchar(16) NOT NULL CHECK (kind IN ('debit', 'credit')),
  net_delta_minor bigint NOT NULL CHECK (net_delta_minor > 0),
  tax_delta_minor bigint NOT NULL CHECK (tax_delta_minor >= 0),
  currency char(3) NOT NULL,
  original_line_id text NOT NULL REFERENCES billing_invoice_lines(id) ON DELETE RESTRICT,
  original_source_digest char(64) NOT NULL,
  tax_treatment varchar(32) NOT NULL
    CHECK (tax_treatment IN ('STANDARD_RATE', 'NO_TAX_CHARGED')),
  tax_rate_bps integer NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  tax_legal_basis varchar(500) NOT NULL CHECK (length(trim(tax_legal_basis)) > 0),
  evidence_digest char(64) NOT NULL,
  created_by_user_id text,
  created_by_email varchar(320) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_manual_correction_tax_treatment_check CHECK (
    (tax_treatment = 'NO_TAX_CHARGED' AND tax_rate_bps = 0) OR
    (tax_treatment = 'STANDARD_RATE' AND tax_rate_bps > 0)
  ),
  CONSTRAINT billing_manual_correction_supplement_check CHECK (
    kind = 'credit' OR supplement_invoice_id IS NOT NULL
  )
);

CREATE INDEX billing_manual_correction_original_idx
  ON billing_cycle_manual_corrections(original_cycle_id);

CREATE FUNCTION billing_manual_correction_identity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE pending record; original record; invoice record; line record;
BEGIN
  EXECUTE format('SELECT service_id, org_id, team_id, billing_month, state
    FROM %I.billing_customer_cycles WHERE id = $1', TG_TABLE_SCHEMA)
    INTO pending USING NEW.pending_cycle_id;
  EXECUTE format('SELECT service_id, org_id, team_id, billing_month, state
    FROM %I.billing_customer_cycles WHERE id = $1', TG_TABLE_SCHEMA)
    INTO original USING NEW.original_cycle_id;
  EXECUTE format('SELECT invoice_id, service_id FROM %I.billing_invoice_lines WHERE id = $1',
    TG_TABLE_SCHEMA) INTO line USING NEW.original_line_id;
  IF pending IS NULL OR original IS NULL OR line IS NULL OR
    pending.service_id <> original.service_id OR pending.org_id <> original.org_id OR
    pending.team_id IS DISTINCT FROM original.team_id OR
    pending.billing_month <> original.billing_month OR
    pending.state <> 'pending_reconciliation' OR
    original.state NOT IN ('finalized', 'adjusted') OR
    line.service_id <> pending.service_id THEN
    RAISE EXCEPTION 'manual cycle correction source mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.supplement_invoice_id IS NOT NULL THEN
    EXECUTE format('SELECT org_id, billing_month, currency, status
      FROM %I.billing_invoices WHERE id = $1', TG_TABLE_SCHEMA)
      INTO invoice USING NEW.supplement_invoice_id;
    IF invoice IS NULL OR invoice.org_id <> pending.org_id OR
      invoice.billing_month <> pending.billing_month OR
      invoice.currency <> NEW.currency OR invoice.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'manual cycle correction supplement mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_manual_correction_identity_guard
BEFORE INSERT ON billing_cycle_manual_corrections
FOR EACH ROW EXECUTE FUNCTION billing_manual_correction_identity_guard();
CREATE TRIGGER billing_manual_correction_immutable
BEFORE UPDATE OR DELETE ON billing_cycle_manual_corrections
FOR EACH ROW EXECUTE FUNCTION billing_invoice_line_financial_immutable();

GRANT SELECT, INSERT ON billing_cycle_manual_corrections TO uoa_app, uoa_admin;

COMMIT;
