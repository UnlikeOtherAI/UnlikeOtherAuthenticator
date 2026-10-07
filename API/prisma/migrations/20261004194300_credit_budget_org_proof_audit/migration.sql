ALTER TABLE billing_credit_budget_receipt_proof_audit
  ALTER COLUMN team_id DROP NOT NULL,
  ADD COLUMN budget_scope_type varchar(24),
  ADD COLUMN excluded_team_id text;

ALTER TABLE billing_credit_budget_receipt_proof_audit
  ADD CONSTRAINT billing_credit_budget_org_proof_scope CHECK (
    (budget_scope_type IS NULL AND team_id IS NOT NULL)
    OR (budget_scope_type = 'organization' AND team_id IS NULL
      AND native_scope_type IS NULL)
  );
