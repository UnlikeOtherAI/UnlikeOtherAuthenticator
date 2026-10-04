CREATE TABLE billing_credit_budget_receipt_proof_audit (
  id text PRIMARY KEY,
  product varchar(100) NOT NULL,
  org_id text NOT NULL,
  team_id text NOT NULL,
  billing_month char(7) NOT NULL,
  excluded_dispatch_id varchar(160),
  ledger_cursor varchar(64) NOT NULL UNIQUE,
  signature_sha256 char(64) NOT NULL,
  captured_at timestamp(3) NOT NULL,
  paid_receipt_count integer NOT NULL,
  paid_receipt_sha256 char(64) NOT NULL,
  zero_incremental_count integer NOT NULL,
  zero_incremental_sha256 char(64) NOT NULL,
  pending_dispatch_count integer NOT NULL,
  pending_dispatch_sha256 char(64) NOT NULL,
  verified_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT billing_credit_budget_receipt_proof_counts_nonnegative CHECK (
    paid_receipt_count >= 0 AND zero_incremental_count >= 0
    AND pending_dispatch_count >= 0)
);
CREATE INDEX billing_credit_budget_receipt_proof_scope_idx
  ON billing_credit_budget_receipt_proof_audit
  (product, org_id, team_id, billing_month, verified_at);

CREATE FUNCTION billing_credit_budget_receipt_proof_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'credit budget receipt proof is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER billing_credit_budget_receipt_proof_immutable
BEFORE UPDATE OR DELETE ON billing_credit_budget_receipt_proof_audit
FOR EACH ROW EXECUTE FUNCTION billing_credit_budget_receipt_proof_immutable();
