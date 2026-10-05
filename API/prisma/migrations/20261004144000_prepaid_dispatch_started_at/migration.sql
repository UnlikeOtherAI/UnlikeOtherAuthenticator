ALTER TABLE "billing_prepaid_reservations"
  ADD COLUMN "dispatch_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "billing_prepaid_reservations"
  ALTER COLUMN "dispatch_started_at" DROP DEFAULT;
CREATE OR REPLACE FUNCTION billing_prepaid_reservation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD."dispatch_id", OLD."credit_account_id", OLD."tariff_id", OLD."service_id",
      OLD."provider_service_id", OLD."app_key_id", OLD."org_id", OLD."team_id", OLD."user_id",
      OLD."billing_month", OLD."dispatch_started_at", OLD."currency", OLD."raw_cost_bound",
      OLD."reserved_microcredits", OLD."created_at")
    IS DISTINCT FROM ROW(NEW."dispatch_id", NEW."credit_account_id", NEW."tariff_id", NEW."service_id",
      NEW."provider_service_id", NEW."app_key_id", NEW."org_id", NEW."team_id", NEW."user_id",
      NEW."billing_month", NEW."dispatch_started_at", NEW."currency", NEW."raw_cost_bound",
      NEW."reserved_microcredits", NEW."created_at")
    OR OLD."status" <> 'ACTIVE' OR NEW."status" NOT IN ('SETTLED', 'RELEASED') THEN
    RAISE EXCEPTION 'prepaid reservation identity and terminal state are immutable';
  END IF;
  RETURN NEW;
END $$;
