BEGIN;

CREATE TABLE billing_customer_cycles (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES billing_services(id) ON DELETE RESTRICT,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  billing_month CHAR(7) NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state VARCHAR(32) NOT NULL CHECK (state IN ('pending_reconciliation', 'finalized', 'adjusted')),
  payer_scope "BillingAssignmentScope" NOT NULL,
  public_snapshot JSONB NOT NULL,
  private_evidence JSONB NOT NULL,
  snapshot_sha256 CHAR(64) NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_customer_cycles_binding UNIQUE (service_id, team_id, billing_month, revision),
  CONSTRAINT billing_customer_cycles_month_check CHECK (billing_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
CREATE INDEX billing_customer_cycles_scope_idx
  ON billing_customer_cycles(service_id, team_id, billing_month);

CREATE TABLE billing_customer_cycle_documents (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES billing_customer_cycles(id) ON DELETE RESTRICT,
  kind VARCHAR(32) NOT NULL CHECK (kind IN ('monthly_invoice', 'top_up_invoice', 'credit_note', 'usage_breakdown')),
  format VARCHAR(8) NOT NULL CHECK (format IN ('pdf', 'csv')),
  source_kind VARCHAR(32) NOT NULL,
  source_id VARCHAR(255) NOT NULL,
  invoice_number VARCHAR(120),
  issued_at TIMESTAMPTZ,
  amount_minor BIGINT,
  currency CHAR(3),
  object_key VARCHAR(1024) NOT NULL,
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_customer_cycle_documents_source_key UNIQUE (source_kind, source_id),
  CONSTRAINT billing_customer_cycle_documents_kind_key UNIQUE (cycle_id, kind, format),
  CONSTRAINT billing_customer_cycle_documents_amount_check CHECK (
    (amount_minor IS NULL AND currency IS NULL) OR
    (amount_minor IS NOT NULL AND currency ~ '^[A-Z]{3}$')
  )
);

CREATE FUNCTION billing_customer_cycle_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'BILLING_CUSTOMER_CYCLE_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER billing_customer_cycle_immutable_row
  BEFORE UPDATE OR DELETE ON billing_customer_cycles
  FOR EACH ROW EXECUTE FUNCTION billing_customer_cycle_immutable();
CREATE TRIGGER billing_customer_cycle_document_immutable_row
  BEFORE UPDATE OR DELETE ON billing_customer_cycle_documents
  FOR EACH ROW EXECUTE FUNCTION billing_customer_cycle_immutable();

COMMIT;
