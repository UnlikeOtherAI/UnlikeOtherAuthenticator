CREATE TYPE "BillingPrepaidReservationStatus" AS ENUM ('ACTIVE', 'SETTLED', 'RELEASED');

CREATE TABLE "billing_prepaid_reservations" (
  "id" TEXT PRIMARY KEY,
  "dispatch_id" VARCHAR(160) NOT NULL UNIQUE,
  "receipt_id" VARCHAR(160) UNIQUE,
  "credit_account_id" TEXT NOT NULL REFERENCES "billing_credit_accounts"("id") ON DELETE RESTRICT,
  "tariff_id" TEXT NOT NULL REFERENCES "billing_tariffs"("id") ON DELETE RESTRICT,
  "service_id" TEXT NOT NULL,
  "app_key_id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "billing_month" CHAR(7) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "raw_cost_bound" DECIMAL(38,18) NOT NULL,
  "reserved_microcredits" BIGINT NOT NULL,
  "raw_cost_actual" DECIMAL(38,18),
  "debited_microcredits" BIGINT,
  "status" "BillingPrepaidReservationStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "terminal_at" TIMESTAMP(3),
  CONSTRAINT "billing_prepaid_reservation_amounts_valid" CHECK (
    "raw_cost_bound" >= 0 AND "reserved_microcredits" >= 0
    AND ("raw_cost_actual" IS NULL OR "raw_cost_actual" >= 0)
    AND ("debited_microcredits" IS NULL OR "debited_microcredits" >= 0)
  ),
  CONSTRAINT "billing_prepaid_reservation_terminal_valid" CHECK (
    ("status" = 'ACTIVE' AND "receipt_id" IS NULL AND "raw_cost_actual" IS NULL
      AND "debited_microcredits" IS NULL AND "terminal_at" IS NULL)
    OR ("status" = 'SETTLED' AND "receipt_id" IS NOT NULL AND "raw_cost_actual" IS NOT NULL
      AND "debited_microcredits" IS NOT NULL AND "terminal_at" IS NOT NULL)
    OR ("status" = 'RELEASED' AND "receipt_id" IS NOT NULL AND "raw_cost_actual" IS NULL
      AND "debited_microcredits" IS NULL AND "terminal_at" IS NOT NULL)
  )
);
CREATE INDEX "billing_prepaid_reservations_account_status_idx"
  ON "billing_prepaid_reservations"("credit_account_id", "status");
CREATE INDEX "billing_prepaid_reservations_origin_month_idx"
  ON "billing_prepaid_reservations"("org_id", "team_id", "billing_month");

CREATE TABLE "billing_prepaid_reservation_events" (
  "id" TEXT PRIMARY KEY,
  "reservation_id" TEXT NOT NULL REFERENCES "billing_prepaid_reservations"("id") ON DELETE RESTRICT,
  "kind" VARCHAR(24) NOT NULL CHECK ("kind" IN ('RESERVED', 'SETTLED', 'RELEASED')),
  "receipt_id" VARCHAR(160),
  "amount_microcredits" BIGINT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "billing_prepaid_reservation_events_history_idx"
  ON "billing_prepaid_reservation_events"("reservation_id", "created_at");

CREATE FUNCTION billing_prepaid_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'prepaid reservation events are append-only';
END $$;
CREATE TRIGGER billing_prepaid_event_append_only
  BEFORE UPDATE OR DELETE ON "billing_prepaid_reservation_events"
  FOR EACH ROW EXECUTE FUNCTION billing_prepaid_event_append_only();

CREATE FUNCTION billing_prepaid_reservation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD."dispatch_id", OLD."credit_account_id", OLD."tariff_id", OLD."service_id",
      OLD."app_key_id", OLD."org_id", OLD."team_id", OLD."user_id", OLD."billing_month",
      OLD."currency", OLD."raw_cost_bound", OLD."reserved_microcredits", OLD."created_at")
    IS DISTINCT FROM ROW(NEW."dispatch_id", NEW."credit_account_id", NEW."tariff_id", NEW."service_id",
      NEW."app_key_id", NEW."org_id", NEW."team_id", NEW."user_id", NEW."billing_month",
      NEW."currency", NEW."raw_cost_bound", NEW."reserved_microcredits", NEW."created_at")
    OR OLD."status" <> 'ACTIVE' OR NEW."status" NOT IN ('SETTLED', 'RELEASED') THEN
    RAISE EXCEPTION 'prepaid reservation identity and terminal state are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_prepaid_reservation_transition
  BEFORE UPDATE ON "billing_prepaid_reservations"
  FOR EACH ROW EXECUTE FUNCTION billing_prepaid_reservation_transition();

-- Every existing funding/debit path updates this same account row. A debit or
-- refund cannot consume funds already committed to an in-flight provider call.
CREATE FUNCTION billing_prepaid_protect_reserved_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE held BIGINT;
BEGIN
  SELECT COALESCE(SUM("reserved_microcredits"), 0) INTO held
    FROM "billing_prepaid_reservations"
    WHERE "credit_account_id" = NEW."id" AND "status" = 'ACTIVE';
  IF NEW."balance_microcredits" < held THEN
    RAISE EXCEPTION 'prepaid reserved balance cannot be consumed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_prepaid_protect_reserved_balance
  BEFORE UPDATE OF "balance_microcredits" ON "billing_credit_accounts"
  FOR EACH ROW EXECUTE FUNCTION billing_prepaid_protect_reserved_balance();
