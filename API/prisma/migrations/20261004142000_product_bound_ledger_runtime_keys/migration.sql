CREATE TABLE "billing_ledger_runtime_keys" (
  "id" TEXT PRIMARY KEY,
  "service_id" TEXT NOT NULL REFERENCES "billing_services"("id") ON DELETE RESTRICT,
  "secret_digest" CHAR(64) NOT NULL UNIQUE,
  "key_prefix" VARCHAR(24) NOT NULL,
  "ledger_audience" VARCHAR(255) NOT NULL,
  "source_domain" VARCHAR(255) NOT NULL,
  "created_by_email" VARCHAR(200) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3)
);
CREATE INDEX "billing_ledger_runtime_keys_service_revoked_idx"
  ON "billing_ledger_runtime_keys"("service_id", "revoked_at");

ALTER TABLE "billing_prepaid_reservations"
  ADD COLUMN "provider_service_id" VARCHAR(160) NOT NULL,
  ADD CONSTRAINT "billing_prepaid_reservations_runtime_key_fkey"
    FOREIGN KEY ("app_key_id") REFERENCES "billing_ledger_runtime_keys"("id") ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION billing_prepaid_reservation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD."dispatch_id", OLD."credit_account_id", OLD."tariff_id", OLD."service_id",
      OLD."provider_service_id", OLD."app_key_id", OLD."org_id", OLD."team_id", OLD."user_id",
      OLD."billing_month", OLD."currency", OLD."raw_cost_bound", OLD."reserved_microcredits", OLD."created_at")
    IS DISTINCT FROM ROW(NEW."dispatch_id", NEW."credit_account_id", NEW."tariff_id", NEW."service_id",
      NEW."provider_service_id", NEW."app_key_id", NEW."org_id", NEW."team_id", NEW."user_id",
      NEW."billing_month", NEW."currency", NEW."raw_cost_bound", NEW."reserved_microcredits", NEW."created_at")
    OR OLD."status" <> 'ACTIVE' OR NEW."status" NOT IN ('SETTLED', 'RELEASED') THEN
    RAISE EXCEPTION 'prepaid reservation identity and terminal state are immutable';
  END IF;
  RETURN NEW;
END $$;
