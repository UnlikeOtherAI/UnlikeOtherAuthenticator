ALTER TABLE "billing_ledger_dispatch_decisions"
  ADD COLUMN "raw_cost_bound" DECIMAL(38,18);
ALTER TABLE "billing_ledger_dispatch_decisions"
  ADD CONSTRAINT "billing_ledger_dispatch_decision_cost_positive"
    CHECK ("raw_cost_bound" IS NULL OR "raw_cost_bound" >= 0);
