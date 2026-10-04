ALTER TABLE billing_credit_budget_receipt_proof_audit
  ADD COLUMN native_scope_type varchar(24),
  ADD COLUMN native_scope_id varchar(256),
  ADD COLUMN native_born_at timestamp(3),
  ADD COLUMN native_owner_sub text;

ALTER TABLE billing_credit_budget_receipt_proof_audit
  ADD CONSTRAINT billing_credit_budget_native_proof_tuple CHECK (
    (native_scope_type IS NULL AND native_scope_id IS NULL
      AND native_born_at IS NULL AND native_owner_sub IS NULL)
    OR (native_scope_type = 'project' AND native_scope_id IS NOT NULL
      AND native_born_at IS NOT NULL AND native_owner_sub IS NULL)
    OR (native_scope_type = 'run' AND native_scope_id IS NOT NULL
      AND native_born_at IS NOT NULL AND native_owner_sub IS NOT NULL)
  );
