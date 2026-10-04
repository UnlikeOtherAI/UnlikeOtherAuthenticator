CREATE TABLE "billing_stripe_invoice_closes" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "stripe_invoice_id" VARCHAR(255) NOT NULL UNIQUE,
  "billing_month" CHAR(7) NOT NULL,
  "period_starts_at" TIMESTAMP(3) NOT NULL,
  "period_ends_at" TIMESTAMP(3) NOT NULL,
  "state" VARCHAR(32) NOT NULL,
  "ledger_snapshot_cursor" VARCHAR(80),
  "unbilled_amount_micro_minor" BIGINT,
  "invoiced_usage_amount_minor" BIGINT,
  "invoiced_usage_line_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "currency" CHAR(3) NOT NULL,
  "ready_at" TIMESTAMP(3),
  "next_check_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error" VARCHAR(160),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_stripe_invoice_closes_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "billing_stripe_subscriptions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "billing_stripe_invoice_closes_state_check"
    CHECK ("state" IN ('HELD', 'READY', 'RELEASED', 'FINALIZED_HOLD', 'FINALIZED_CLEAR', 'COMPENSATED')),
  CONSTRAINT "billing_stripe_invoice_closes_amount_check"
    CHECK ("unbilled_amount_micro_minor" IS NULL OR "unbilled_amount_micro_minor" >= 0)
);
CREATE UNIQUE INDEX "billing_stripe_invoice_closes_subscription_id_billing_month_key"
  ON "billing_stripe_invoice_closes"("subscription_id", "billing_month");
CREATE INDEX "billing_stripe_invoice_closes_state_next_check_at_idx"
  ON "billing_stripe_invoice_closes"("state", "next_check_at");

CREATE FUNCTION "billing_stripe_invoice_close_identity_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD."account_id", OLD."subscription_id", OLD."stripe_invoice_id",
         OLD."billing_month", OLD."period_starts_at", OLD."period_ends_at", OLD."currency")
     IS DISTINCT FROM
     ROW(NEW."account_id", NEW."subscription_id", NEW."stripe_invoice_id",
         NEW."billing_month", NEW."period_starts_at", NEW."period_ends_at", NEW."currency") THEN
    RAISE EXCEPTION 'invoice close source identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "billing_stripe_invoice_close_identity_immutable"
  BEFORE UPDATE ON "billing_stripe_invoice_closes"
  FOR EACH ROW EXECUTE FUNCTION "billing_stripe_invoice_close_identity_immutable"();

CREATE TABLE "billing_stripe_invoice_close_resolutions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "close_id" TEXT NOT NULL,
  "stripe_adjustment_invoice_id" VARCHAR(255) NOT NULL,
  "stripe_adjustment_line_id" VARCHAR(255) NOT NULL,
  "amount_micro_minor" BIGINT NOT NULL,
  "paid_amount_minor" BIGINT NOT NULL,
  "ledger_snapshot_cursor" VARCHAR(80) NOT NULL,
  "actor_email" VARCHAR(255) NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_stripe_invoice_close_resolutions_close_id_fkey"
    FOREIGN KEY ("close_id") REFERENCES "billing_stripe_invoice_closes"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "billing_stripe_invoice_close_resolutions_amount_check"
    CHECK ("amount_micro_minor" > 0)
);
CREATE UNIQUE INDEX "billing_close_resolution_invoice_key"
  ON "billing_stripe_invoice_close_resolutions"("stripe_adjustment_invoice_id");
CREATE UNIQUE INDEX "billing_close_resolution_line_key"
  ON "billing_stripe_invoice_close_resolutions"("stripe_adjustment_line_id");

CREATE FUNCTION "billing_stripe_invoice_close_resolution_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'invoice close adjustment evidence is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "billing_stripe_invoice_close_resolution_immutable"
  BEFORE UPDATE OR DELETE ON "billing_stripe_invoice_close_resolutions"
  FOR EACH ROW EXECUTE FUNCTION "billing_stripe_invoice_close_resolution_immutable"();
