CREATE TABLE "billing_paid_usage_exceptions" (
  "dispatch_id" VARCHAR(160) NOT NULL,
  "receipt_id" VARCHAR(160) NOT NULL,
  "runtime_key_id" TEXT NOT NULL,
  "evidence_digest" CHAR(64) NOT NULL,
  "raw_cost_actual" DECIMAL(38,18) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'HELD',
  "gross_rated_microcredits" BIGINT,
  "collectible_microcredits" BIGINT,
  "waived_microcredits" BIGINT,
  "operator_user_id" TEXT,
  "operator_reason" VARCHAR(500),
  "idempotency_key" VARCHAR(160),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "terminal_at" TIMESTAMP(3),
  CONSTRAINT "billing_paid_usage_exceptions_pkey" PRIMARY KEY ("dispatch_id"),
  CONSTRAINT "billing_paid_usage_exceptions_amounts_check" CHECK (
    "raw_cost_actual" >= 0 AND
    ("status" = 'HELD' AND "gross_rated_microcredits" IS NULL
      AND "collectible_microcredits" IS NULL AND "waived_microcredits" IS NULL
      AND "operator_user_id" IS NULL AND "terminal_at" IS NULL)
    OR ("status" = 'WRITTEN_OFF' AND "gross_rated_microcredits" IS NOT NULL
      AND "collectible_microcredits" IS NOT NULL AND "waived_microcredits" IS NOT NULL
      AND "gross_rated_microcredits" = "collectible_microcredits" + "waived_microcredits"
      AND "operator_user_id" IS NOT NULL AND "terminal_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "billing_paid_usage_exceptions_receipt_id_key"
  ON "billing_paid_usage_exceptions"("receipt_id");
CREATE UNIQUE INDEX "billing_paid_usage_exceptions_idempotency_key_key"
  ON "billing_paid_usage_exceptions"("idempotency_key");
CREATE INDEX "billing_paid_usage_exceptions_status_created_at_idx"
  ON "billing_paid_usage_exceptions"("status", "created_at");
ALTER TABLE "billing_paid_usage_exceptions"
  ADD CONSTRAINT "billing_paid_usage_exceptions_dispatch_id_fkey"
  FOREIGN KEY ("dispatch_id") REFERENCES "billing_credit_budget_dispatches"("dispatch_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_paid_usage_exceptions"
  ADD CONSTRAINT "billing_paid_usage_exceptions_runtime_key_id_fkey"
  FOREIGN KEY ("runtime_key_id") REFERENCES "billing_ledger_runtime_keys"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION billing_paid_usage_exception_once() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'HELD'
    OR NEW.status <> 'WRITTEN_OFF'
    OR (to_jsonb(NEW) - 'status' - 'gross_rated_microcredits'
      - 'collectible_microcredits' - 'waived_microcredits' - 'operator_user_id'
      - 'operator_reason' - 'idempotency_key' - 'terminal_at')
      IS DISTINCT FROM
      (to_jsonb(OLD) - 'status' - 'gross_rated_microcredits'
      - 'collectible_microcredits' - 'waived_microcredits' - 'operator_user_id'
      - 'operator_reason' - 'idempotency_key' - 'terminal_at') THEN
    RAISE EXCEPTION 'paid usage exception evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_paid_usage_exception_once
BEFORE UPDATE OR DELETE ON "billing_paid_usage_exceptions"
FOR EACH ROW EXECUTE FUNCTION billing_paid_usage_exception_once();
