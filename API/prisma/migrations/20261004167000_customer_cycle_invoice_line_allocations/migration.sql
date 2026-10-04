BEGIN;

CREATE TABLE billing_customer_cycle_invoice_allocations (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES billing_customer_cycles(id) ON DELETE RESTRICT,
  authority_key CHAR(64) NOT NULL UNIQUE CHECK (authority_key ~ '^[0-9a-f]{64}$'),
  source_kind VARCHAR(16) NOT NULL CHECK (source_kind IN ('manual', 'stripe')),
  source_account_id VARCHAR(255),
  source_invoice_id VARCHAR(255) NOT NULL,
  source_line_id VARCHAR(255) NOT NULL,
  period_starts_at TIMESTAMPTZ NOT NULL,
  period_ends_at TIMESTAMPTZ NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source_digest CHAR(64) NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_cycle_allocation_period_check CHECK (period_starts_at < period_ends_at),
  CONSTRAINT billing_cycle_allocation_account_check CHECK (
    (source_kind = 'manual' AND source_account_id IS NULL) OR
    (source_kind = 'stripe' AND source_account_id IS NOT NULL)
  )
);
CREATE INDEX billing_customer_cycle_invoice_allocations_cycle_id_idx
  ON billing_customer_cycle_invoice_allocations(cycle_id);
CREATE TRIGGER billing_customer_cycle_invoice_allocation_immutable_row
  BEFORE UPDATE OR DELETE ON billing_customer_cycle_invoice_allocations
  FOR EACH ROW EXECUTE FUNCTION billing_customer_cycle_immutable();

COMMIT;
