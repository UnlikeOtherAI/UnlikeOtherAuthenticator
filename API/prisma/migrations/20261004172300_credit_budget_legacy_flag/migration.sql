ALTER TABLE billing_credit_budget_dispatches
  ADD COLUMN is_legacy boolean NOT NULL DEFAULT false;
