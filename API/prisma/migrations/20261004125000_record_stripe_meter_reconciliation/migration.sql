CREATE TABLE "billing_stripe_usage_reconciliations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "export_id" TEXT NOT NULL,
  "outcome" VARCHAR(32) NOT NULL,
  "evidence_reference" VARCHAR(255) NOT NULL,
  "prior_event_identifier" VARCHAR(100) NOT NULL,
  "prior_attempt_generation" INTEGER NOT NULL,
  "actor_email" VARCHAR(255) NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_stripe_usage_reconciliations_export_id_fkey"
    FOREIGN KEY ("export_id") REFERENCES "billing_stripe_usage_exports"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "billing_stripe_usage_reconciliations_outcome_check"
    CHECK ("outcome" IN ('accepted', 'not_accepted', 'manual_invoice'))
);

CREATE INDEX "billing_stripe_usage_reconciliations_export_id_created_at_idx"
  ON "billing_stripe_usage_reconciliations"("export_id", "created_at");

CREATE FUNCTION "billing_stripe_usage_reconciliation_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'billing meter reconciliation evidence is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "billing_stripe_usage_reconciliation_immutable"
  BEFORE UPDATE OR DELETE ON "billing_stripe_usage_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION "billing_stripe_usage_reconciliation_immutable"();

ALTER TABLE "billing_stripe_usage_exports"
  DROP CONSTRAINT "billing_stripe_usage_exports_delivery_state_check";
ALTER TABLE "billing_stripe_usage_exports"
  ADD CONSTRAINT "billing_stripe_usage_exports_delivery_state_check" CHECK (
    ("stripe_meter_event_state" = 'ACCEPTED') = ("stripe_meter_event_created_at" IS NOT NULL)
    AND ("stripe_meter_event_state" IN ('UNCERTAIN', 'RECONCILIATION_REQUIRED', 'MANUAL_SETTLED')
         OR "stripe_meter_event_attempted_at" IS NULL
         OR "stripe_meter_event_state" = 'ACCEPTED')
  );
