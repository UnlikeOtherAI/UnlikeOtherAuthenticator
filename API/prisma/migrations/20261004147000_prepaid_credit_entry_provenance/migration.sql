ALTER TABLE "billing_credit_entries"
  ADD COLUMN "ledger_runtime_key_id" TEXT REFERENCES "billing_ledger_runtime_keys"("id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "billing_credit_prepaid_reservation_once"
  ON "billing_credit_entries"("source_id")
  WHERE "source_type" = 'prepaid_provider_receipt';
ALTER TABLE "billing_credit_accounts" DROP CONSTRAINT "billing_credit_accounts_exact_unit_check";
ALTER TABLE "billing_credit_accounts" ADD CONSTRAINT "billing_credit_accounts_threshold_unit_check"
  CHECK ("auto_top_up_threshold_microcredits" IS NULL OR "auto_top_up_threshold_microcredits" % 10 = 0);
ALTER TABLE "billing_credit_entries" DROP CONSTRAINT "billing_credit_entries_exact_unit_check";
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "billing_credit_entries_amount_unit_check"
  CHECK ("kind" = 'PREPAID_USAGE' OR "amount_microcredits" % 10 = 0);

CREATE OR REPLACE FUNCTION "billing_credit_entry_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_row "billing_credit_accounts"%ROWTYPE;
  source_row "billing_credit_entries"%ROWTYPE;
  admin_row "billing_credit_admin_adjustments"%ROWTYPE;
  payment_row "billing_credit_payment_adjustments"%ROWTYPE;
  payment_kind BOOLEAN;
  reversal BOOLEAN;
  signed_delta NUMERIC;
  next_balance NUMERIC;
BEGIN
  SELECT * INTO account_row FROM "billing_credit_accounts"
    WHERE "id" = NEW."credit_account_id" FOR UPDATE;
  IF account_row."id" IS NULL OR account_row."currency" <> NEW."currency" THEN
    RAISE EXCEPTION 'credit entry does not match its account' USING ERRCODE = '23514';
  END IF;
  payment_kind := NEW."kind" IN ('REFUND', 'DISPUTE', 'REFUND_REVERSAL', 'DISPUTE_REVERSAL');
  reversal := NEW."kind" IN ('REFUND_REVERSAL', 'DISPUTE_REVERSAL');
  IF NEW."kind" = 'ADJUSTMENT' THEN
    SELECT * INTO admin_row FROM "billing_credit_admin_adjustments" WHERE "id" = NEW."source_id";
    IF admin_row."id" IS NULL OR NEW."source_type" <> 'credit_admin_adjustment'
       OR NEW."service_id" IS NOT NULL OR NEW."app_key_id" IS NOT NULL OR NEW."attributed_user_id" IS NOT NULL
       OR admin_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
       OR admin_row."credit_entry_id" IS DISTINCT FROM NEW."id"
       OR admin_row."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
       OR abs(admin_row."signed_amount_microcredits"::numeric) IS DISTINCT FROM NEW."amount_microcredits"::numeric
       OR NEW."direction" IS DISTINCT FROM (CASE WHEN admin_row."signed_amount_microcredits" > 0
         THEN 'CREDIT'::"BillingCreditEntryDirection" ELSE 'DEBIT'::"BillingCreditEntryDirection" END) THEN
      RAISE EXCEPTION 'admin credit adjustment entry lacks exact immutable evidence' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."kind" = 'PREPAID_USAGE' THEN
    IF NEW."service_id" IS NULL OR NEW."app_key_id" IS NOT NULL
       OR NEW."ledger_runtime_key_id" IS NULL OR NEW."direction" <> 'DEBIT'
       OR NEW."source_type" <> 'prepaid_provider_receipt'
       OR NOT EXISTS (
         SELECT 1 FROM "billing_prepaid_reservations" AS reservation
         WHERE reservation."id" = NEW."source_id"
           AND reservation."status" = 'SETTLED'
           AND reservation."credit_account_id" = NEW."credit_account_id"
           AND reservation."service_id" = NEW."service_id"
           AND reservation."app_key_id" = NEW."ledger_runtime_key_id"
           AND reservation."user_id" = NEW."attributed_user_id"
           AND reservation."currency" = NEW."currency"
           AND reservation."debited_microcredits" = NEW."amount_microcredits"
       ) THEN
      RAISE EXCEPTION 'prepaid debit requires exact settled reservation evidence' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."ledger_runtime_key_id" IS NOT NULL THEN
      RAISE EXCEPTION 'runtime key belongs only to prepaid usage' USING ERRCODE = '23514';
    END IF;
    IF NEW."service_id" IS NULL OR NEW."app_key_id" IS NULL THEN
      RAISE EXCEPTION 'product credit entries require exact service and app-key provenance' USING ERRCODE = '23514';
    END IF;
    IF NEW."kind" IN ('USAGE_SETTLEMENT', 'USAGE_SETTLEMENT_CORRECTION') THEN
      PERFORM "billing_assert_credit_app_key_provenance"(NEW."app_key_id", true);
    ELSE
      PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");
    END IF;
    IF payment_kind THEN
      SELECT * INTO payment_row FROM "billing_credit_payment_adjustments" WHERE "id" = NEW."source_id";
      IF payment_row."id" IS NULL OR NEW."source_type" <> 'credit_payment_adjustment'
         OR payment_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
         OR payment_row."service_id" IS DISTINCT FROM NEW."service_id"
         OR payment_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
         OR payment_row."kind"::text IS DISTINCT FROM NEW."kind"::text
         OR payment_row."original_entry_id" IS DISTINCT FROM NEW."reverses_entry_id"
         OR payment_row."credit_entry_id" IS DISTINCT FROM NEW."id"
         OR payment_row."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
         OR payment_row."amount_microcredits" IS DISTINCT FROM NEW."amount_microcredits" THEN
        RAISE EXCEPTION 'payment adjustment entry lacks exact immutable Stripe evidence' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF payment_kind THEN
    SELECT * INTO source_row FROM "billing_credit_entries"
      WHERE "id" = NEW."reverses_entry_id" FOR KEY SHARE;
    IF source_row."id" IS NULL OR source_row."kind" NOT IN ('TOP_UP', 'AUTOMATIC_TOP_UP')
       OR source_row."direction" <> 'CREDIT'
       OR source_row."credit_account_id" <> NEW."credit_account_id"
       OR source_row."service_id" IS DISTINCT FROM NEW."service_id"
       OR source_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
       OR source_row."attributed_user_id" IS DISTINCT FROM NEW."attributed_user_id"
       OR source_row."currency" <> NEW."currency"
       OR NEW."amount_microcredits" > source_row."amount_microcredits"
       OR (reversal AND NEW."direction" <> 'CREDIT')
       OR (NOT reversal AND NEW."direction" <> 'DEBIT') THEN
      RAISE EXCEPTION 'credit payment adjustment does not match its paid source entry' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."reverses_entry_id" IS NOT NULL THEN
    RAISE EXCEPTION 'only a verified payment adjustment may reference a paid entry' USING ERRCODE = '23514';
  END IF;

  signed_delta := CASE NEW."direction" WHEN 'CREDIT' THEN NEW."amount_microcredits"::numeric
    ELSE -NEW."amount_microcredits"::numeric END;
  next_balance := account_row."balance_microcredits"::numeric + signed_delta;
  IF next_balance < -9223372036854775808 OR next_balance > 9223372036854775807 THEN
    RAISE EXCEPTION 'credit balance exceeds supported precision' USING ERRCODE = '22003';
  END IF;
  IF NEW."kind" IN ('USAGE_SETTLEMENT', 'USAGE_SETTLEMENT_CORRECTION', 'PREPAID_USAGE')
     AND NEW."direction" = 'DEBIT' AND next_balance < 0 THEN
    RAISE EXCEPTION 'rated usage cannot consume more credits than are available' USING ERRCODE = '23514';
  END IF;
  IF NEW."balance_after_microcredits"::numeric <> next_balance THEN
    RAISE EXCEPTION 'credit entry balance-after does not match the locked account balance' USING ERRCODE = '40001';
  END IF;
  UPDATE "billing_credit_accounts"
  SET "balance_microcredits" = next_balance::bigint, "updated_at" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."credit_account_id";
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "billing_credit_entry_source_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" = 'PREPAID_USAGE' AND NOT EXISTS (
    SELECT 1 FROM "billing_prepaid_reservations" AS reservation
    WHERE reservation."id" = NEW."source_id"
      AND NEW."source_type" = 'prepaid_provider_receipt'
      AND reservation."status" = 'SETTLED'
      AND reservation."credit_account_id" = NEW."credit_account_id"
      AND reservation."service_id" = NEW."service_id"
      AND reservation."app_key_id" = NEW."ledger_runtime_key_id"
      AND reservation."user_id" = NEW."attributed_user_id"
      AND reservation."debited_microcredits" = NEW."amount_microcredits"
  ) THEN RAISE EXCEPTION 'prepaid debit must commit with exact reservation evidence' USING ERRCODE = '23514';
  ELSIF NEW."kind" = 'TOP_UP' AND NOT EXISTS (
    SELECT 1 FROM "billing_credit_top_up_checkouts" AS checkout
    WHERE checkout."id" = NEW."source_id" AND NEW."source_type" = 'credit_top_up_checkout'
      AND checkout."status" = 'COMPLETE' AND checkout."credit_entry_id" = NEW."id"
      AND checkout."credit_account_id" = NEW."credit_account_id"
      AND checkout."service_id" = NEW."service_id" AND checkout."app_key_id" = NEW."app_key_id"
      AND checkout."requested_by_user_id" = NEW."attributed_user_id"
      AND checkout."credits_received_microcredits" = NEW."amount_microcredits"
  ) THEN RAISE EXCEPTION 'top-up entry must commit with exact paid checkout evidence' USING ERRCODE = '23514';
  ELSIF NEW."kind" = 'AUTOMATIC_TOP_UP' AND NOT EXISTS (
    SELECT 1 FROM "billing_credit_auto_top_up_attempts" AS attempt
    WHERE attempt."id" = NEW."source_id" AND NEW."source_type" = 'credit_auto_top_up_attempt'
      AND attempt."status" = 'SUCCEEDED' AND attempt."credit_entry_id" = NEW."id"
      AND attempt."credit_account_id" = NEW."credit_account_id"
      AND attempt."service_id" = NEW."service_id" AND attempt."app_key_id" = NEW."app_key_id"
      AND attempt."attributed_user_id" = NEW."attributed_user_id"
      AND attempt."credits_received_microcredits" = NEW."amount_microcredits"
  ) THEN RAISE EXCEPTION 'automatic top-up entry must commit with exact successful attempt evidence' USING ERRCODE = '23514';
  ELSIF NEW."kind" IN ('USAGE_SETTLEMENT', 'USAGE_SETTLEMENT_CORRECTION') AND NOT EXISTS (
    SELECT 1 FROM "billing_credit_usage_settlement_adjustments" AS adjustment
    WHERE adjustment."id" = NEW."source_id" AND NEW."source_type" = 'credit_usage_settlement_adjustment'
      AND adjustment."credit_entry_id" = NEW."id" AND adjustment."credit_account_id" = NEW."credit_account_id"
      AND adjustment."service_id" = NEW."service_id" AND adjustment."app_key_id" = NEW."app_key_id"
      AND abs(adjustment."delta_credits_consumed_microcredits"::numeric) = NEW."amount_microcredits"::numeric
  ) THEN RAISE EXCEPTION 'usage entry must commit with exact portfolio settlement evidence' USING ERRCODE = '23514';
  ELSIF NEW."kind" IN ('REFUND', 'DISPUTE', 'REFUND_REVERSAL', 'DISPUTE_REVERSAL') AND NOT EXISTS (
    SELECT 1 FROM "billing_credit_payment_adjustments" AS adjustment
    WHERE adjustment."id" = NEW."source_id" AND NEW."source_type" = 'credit_payment_adjustment'
      AND adjustment."credit_entry_id" = NEW."id" AND adjustment."credit_account_id" = NEW."credit_account_id"
      AND adjustment."service_id" = NEW."service_id" AND adjustment."app_key_id" = NEW."app_key_id"
      AND adjustment."kind"::text = NEW."kind"::text
      AND adjustment."original_entry_id" = NEW."reverses_entry_id"
      AND adjustment."amount_microcredits" = NEW."amount_microcredits"
  ) THEN RAISE EXCEPTION 'payment adjustment entry must commit with exact Stripe evidence' USING ERRCODE = '23514';
  ELSIF NEW."kind" = 'ADJUSTMENT' AND NOT EXISTS (
    SELECT 1 FROM "billing_credit_admin_adjustments" AS adjustment
    WHERE adjustment."id" = NEW."source_id" AND NEW."source_type" = 'credit_admin_adjustment'
      AND adjustment."credit_entry_id" = NEW."id" AND adjustment."credit_account_id" = NEW."credit_account_id"
      AND abs(adjustment."signed_amount_microcredits"::numeric) = NEW."amount_microcredits"::numeric
  ) THEN RAISE EXCEPTION 'admin entry must commit with exact superuser evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

ALTER TABLE "billing_credit_entries"
  DROP CONSTRAINT "billing_credit_entries_kind_check",
  ADD CONSTRAINT "billing_credit_entries_kind_check" CHECK (
    ("kind" IN ('TOP_UP', 'AUTOMATIC_TOP_UP') AND "direction" = 'CREDIT'
      AND "attributed_user_id" IS NOT NULL)
    OR ("kind" = 'USAGE_SETTLEMENT' AND "direction" = 'DEBIT')
    OR ("kind" = 'USAGE_SETTLEMENT_CORRECTION')
    OR ("kind" = 'PREPAID_USAGE' AND "direction" = 'DEBIT'
      AND "app_key_id" IS NULL AND "ledger_runtime_key_id" IS NOT NULL
      AND "source_type" = 'prepaid_provider_receipt')
    OR ("kind" IN ('REFUND', 'DISPUTE') AND "direction" = 'DEBIT'
      AND "reverses_entry_id" IS NOT NULL AND "source_type" = 'credit_payment_adjustment')
    OR ("kind" IN ('REFUND_REVERSAL', 'DISPUTE_REVERSAL') AND "direction" = 'CREDIT'
      AND "reverses_entry_id" IS NOT NULL AND "source_type" = 'credit_payment_adjustment')
    OR ("kind" = 'ADJUSTMENT')
  );

ALTER TABLE "billing_credit_entries"
  DROP CONSTRAINT "billing_credit_entries_provenance_check",
  ADD CONSTRAINT "billing_credit_entries_provenance_check" CHECK (
    ("kind" = 'ADJUSTMENT' AND "service_id" IS NULL AND "app_key_id" IS NULL
      AND "ledger_runtime_key_id" IS NULL AND "attributed_user_id" IS NULL
      AND "source_type" = 'credit_admin_adjustment')
    OR ("kind" = 'PREPAID_USAGE' AND "service_id" IS NOT NULL
      AND "app_key_id" IS NULL AND "ledger_runtime_key_id" IS NOT NULL
      AND "attributed_user_id" IS NOT NULL
      AND "source_type" = 'prepaid_provider_receipt')
    OR ("kind" NOT IN ('ADJUSTMENT', 'PREPAID_USAGE') AND "service_id" IS NOT NULL
      AND "app_key_id" IS NOT NULL AND "ledger_runtime_key_id" IS NULL
      AND "source_type" <> 'credit_admin_adjustment')
  );
