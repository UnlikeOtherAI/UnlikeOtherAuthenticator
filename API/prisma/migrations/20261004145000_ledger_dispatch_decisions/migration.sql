CREATE TYPE "BillingLedgerDispatchDecisionStatus" AS ENUM ('PAY_AS_YOU_GO', 'CANCELLED');
CREATE TABLE "billing_ledger_dispatch_decisions" (
  "dispatch_id" VARCHAR(160) PRIMARY KEY,
  "runtime_key_id" TEXT NOT NULL REFERENCES "billing_ledger_runtime_keys"("id") ON DELETE RESTRICT,
  "service_id" TEXT NOT NULL REFERENCES "billing_services"("id") ON DELETE RESTRICT,
  "provider_service_id" VARCHAR(160),
  "org_id" TEXT,
  "team_id" TEXT,
  "user_id" TEXT,
  "billing_month" CHAR(7),
  "dispatch_started_at" TIMESTAMP(3),
  "currency" CHAR(3),
  "status" "BillingLedgerDispatchDecisionStatus" NOT NULL,
  "receipt_id" VARCHAR(160),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_ledger_dispatch_decision_shape" CHECK (
    ("status" = 'PAY_AS_YOU_GO' AND "provider_service_id" IS NOT NULL
      AND "org_id" IS NOT NULL AND "team_id" IS NOT NULL AND "user_id" IS NOT NULL
      AND "billing_month" IS NOT NULL AND "dispatch_started_at" IS NOT NULL
      AND "currency" IS NOT NULL AND "receipt_id" IS NULL)
    OR ("status" = 'CANCELLED' AND "receipt_id" IS NOT NULL)
  )
);
CREATE FUNCTION billing_ledger_dispatch_decision_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger dispatch decisions are append-only';
END $$;
CREATE TRIGGER billing_ledger_dispatch_decision_append_only
  BEFORE UPDATE OR DELETE ON "billing_ledger_dispatch_decisions"
  FOR EACH ROW EXECUTE FUNCTION billing_ledger_dispatch_decision_append_only();
