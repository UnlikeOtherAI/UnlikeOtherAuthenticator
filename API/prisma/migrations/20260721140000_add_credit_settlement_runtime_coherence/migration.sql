-- A single canonical team portfolio is settled atomically across every billed
-- service. The authenticated storefront app key is adjustment provenance; it
-- is intentionally independent from the service whose usage is being rated.
CREATE FUNCTION "billing_assert_credit_app_key_provenance"(
  expected_app_key_id TEXT,
  require_active BOOLEAN
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "billing_app_keys" AS key
    WHERE key."id" = expected_app_key_id
      AND key."purpose" = 'CUSTOMER_LIFECYCLE'
      AND (
        NOT require_active
        OR (
          key."revoked_at" IS NULL
          AND (key."expires_at" IS NULL OR key."expires_at" > CURRENT_TIMESTAMP)
        )
      )
  ) THEN
    RAISE EXCEPTION 'billing app key is not valid lifecycle provenance'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "billing_credit_entry_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_row "billing_credit_accounts"%ROWTYPE;
  reversed_row "billing_credit_entries"%ROWTYPE;
  adjustment_row "billing_credit_admin_adjustments"%ROWTYPE;
  payment_adjustment_row "billing_credit_payment_adjustments"%ROWTYPE;
  signed_delta NUMERIC;
  next_balance NUMERIC;
BEGIN
  SELECT * INTO account_row
  FROM "billing_credit_accounts"
  WHERE "id" = NEW."credit_account_id"
  FOR UPDATE;
  IF NOT FOUND OR account_row."currency" <> NEW."currency" THEN
    RAISE EXCEPTION 'credit entry does not match its account'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."kind" = 'ADJUSTMENT' THEN
    SELECT * INTO adjustment_row
    FROM "billing_credit_admin_adjustments"
    WHERE "id" = NEW."source_id";
    IF NOT FOUND
       OR NEW."source_type" IS DISTINCT FROM 'credit_admin_adjustment'
       OR NEW."service_id" IS NOT NULL
       OR NEW."app_key_id" IS NOT NULL
       OR NEW."attributed_user_id" IS NOT NULL
       OR adjustment_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
       OR adjustment_row."credit_entry_id" IS DISTINCT FROM NEW."id"
       OR adjustment_row."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
       OR abs(adjustment_row."signed_amount_microcredits"::numeric)
         IS DISTINCT FROM NEW."amount_microcredits"::numeric
       OR NEW."direction" IS DISTINCT FROM (CASE
         WHEN adjustment_row."signed_amount_microcredits" > 0
           THEN 'CREDIT'::"BillingCreditEntryDirection"
         ELSE 'DEBIT'::"BillingCreditEntryDirection"
       END) THEN
      RAISE EXCEPTION 'admin credit adjustment entry lacks exact immutable evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."service_id" IS NULL OR NEW."app_key_id" IS NULL THEN
      RAISE EXCEPTION 'product credit entries require exact service and app-key provenance'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."kind" IN ('USAGE_SETTLEMENT', 'USAGE_SETTLEMENT_CORRECTION') THEN
      PERFORM "billing_assert_credit_app_key_provenance"(NEW."app_key_id", true);
    ELSE
      PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");
    END IF;
    IF NEW."kind" IN ('REFUND', 'DISPUTE') THEN
      SELECT * INTO payment_adjustment_row
      FROM "billing_credit_payment_adjustments"
      WHERE "id" = NEW."source_id";
      IF NOT FOUND
         OR NEW."source_type" IS DISTINCT FROM 'credit_payment_adjustment'
         OR payment_adjustment_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
         OR payment_adjustment_row."service_id" IS DISTINCT FROM NEW."service_id"
         OR payment_adjustment_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
         OR payment_adjustment_row."kind"::text IS DISTINCT FROM NEW."kind"::text
         OR payment_adjustment_row."original_entry_id" IS DISTINCT FROM NEW."reverses_entry_id"
         OR payment_adjustment_row."credit_entry_id" IS DISTINCT FROM NEW."id"
         OR payment_adjustment_row."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
         OR payment_adjustment_row."amount_microcredits" IS DISTINCT FROM NEW."amount_microcredits" THEN
        RAISE EXCEPTION 'payment debit entry lacks exact immutable Stripe evidence'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW."kind" IN ('REFUND', 'DISPUTE') THEN
    IF NEW."reverses_entry_id" IS NULL THEN
      RAISE EXCEPTION 'credit debit/reversal requires an exact source entry'
        USING ERRCODE = '23514';
    END IF;
    SELECT * INTO reversed_row
    FROM "billing_credit_entries"
    WHERE "id" = NEW."reverses_entry_id"
    FOR KEY SHARE;
    IF NOT FOUND
       OR reversed_row."credit_account_id" <> NEW."credit_account_id"
       OR reversed_row."service_id" IS DISTINCT FROM NEW."service_id"
       OR reversed_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
       OR reversed_row."attributed_user_id" IS DISTINCT FROM NEW."attributed_user_id"
       OR reversed_row."currency" <> NEW."currency"
       OR reversed_row."direction" = NEW."direction"
       OR (
         NEW."kind" IN ('REFUND', 'DISPUTE')
         AND (
           reversed_row."kind" NOT IN ('TOP_UP', 'AUTOMATIC_TOP_UP')
           OR reversed_row."direction" <> 'CREDIT'
           OR NEW."direction" <> 'DEBIT'
           OR NEW."amount_microcredits" > reversed_row."amount_microcredits"
         )
       ) THEN
      RAISE EXCEPTION 'credit payment debit does not exactly match its source entry'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."reverses_entry_id" IS NOT NULL THEN
    RAISE EXCEPTION 'only a verified refund or dispute may reference a paid entry'
      USING ERRCODE = '23514';
  END IF;

  signed_delta := CASE NEW."direction"
    WHEN 'CREDIT' THEN NEW."amount_microcredits"::numeric
    ELSE -NEW."amount_microcredits"::numeric
  END;
  next_balance := account_row."balance_microcredits"::numeric + signed_delta;
  IF next_balance < -9223372036854775808 OR next_balance > 9223372036854775807 THEN
    RAISE EXCEPTION 'credit balance exceeds supported precision'
      USING ERRCODE = '22003';
  END IF;
  IF NEW."kind" IN ('USAGE_SETTLEMENT', 'USAGE_SETTLEMENT_CORRECTION')
     AND NEW."direction" = 'DEBIT'
     AND next_balance < 0 THEN
    RAISE EXCEPTION 'rated usage cannot consume more credits than are available'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."balance_after_microcredits"::numeric <> next_balance THEN
    RAISE EXCEPTION 'credit entry balance-after does not match the locked account balance'
      USING ERRCODE = '40001';
  END IF;

  UPDATE "billing_credit_accounts"
  SET "balance_microcredits" = next_balance::bigint,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."credit_account_id";
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "billing_credit_settlement_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_row "billing_credit_accounts"%ROWTYPE;
  tariff_row "billing_tariffs"%ROWTYPE;
  subscription_row "billing_stripe_subscriptions"%ROWTYPE;
BEGIN
  SELECT * INTO credit_row FROM "billing_credit_accounts"
    WHERE "id" = NEW."credit_account_id";
  SELECT * INTO tariff_row FROM "billing_tariffs"
    WHERE "id" = NEW."tariff_id";
  PERFORM "billing_assert_credit_app_key_provenance"(NEW."app_key_id", false);
  IF TG_OP = 'INSERT' THEN
    PERFORM "billing_assert_credit_app_key_provenance"(NEW."app_key_id", true);
  END IF;
  IF credit_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR credit_row."currency" IS DISTINCT FROM 'USD'
     OR tariff_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR tariff_row."currency" IS DISTINCT FROM 'USD'
     OR NEW."currency" <> 'USD' THEN
    RAISE EXCEPTION 'credit settlement must use the shared account and exact USD tariff service'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."subscription_id" IS NOT NULL THEN
    SELECT * INTO subscription_row FROM "billing_stripe_subscriptions"
      WHERE "id" = NEW."subscription_id";
    IF subscription_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR subscription_row."service_id" IS DISTINCT FROM NEW."service_id"
       OR subscription_row."tariff_id" IS DISTINCT FROM NEW."tariff_id"
       OR subscription_row."org_id" IS DISTINCT FROM credit_row."org_id"
       OR (
         subscription_row."team_id" IS NOT NULL
         AND subscription_row."team_id" IS DISTINCT FROM credit_row."team_id"
       ) THEN
      RAISE EXCEPTION 'credit settlement subscription does not cover the exact team service'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND (
    NEW."status" IS DISTINCT FROM 'PENDING'
    OR NEW."cumulative_rated_usage_amount_micro_minor" <> 0
    OR NEW."cumulative_credits_consumed_microcredits" <> 0
    OR NEW."cumulative_remaining_usage_amount_micro_minor" <> 0
  ) THEN
    RAISE EXCEPTION 'new settlement must begin pending at exact zero cumulative totals'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       NEW."cumulative_rated_usage_amount_micro_minor"
         IS DISTINCT FROM OLD."cumulative_rated_usage_amount_micro_minor"
       OR NEW."cumulative_credits_consumed_microcredits"
         IS DISTINCT FROM OLD."cumulative_credits_consumed_microcredits"
       OR NEW."cumulative_remaining_usage_amount_micro_minor"
         IS DISTINCT FROM OLD."cumulative_remaining_usage_amount_micro_minor"
     )
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'settlement totals may advance only through an immutable adjustment'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "billing_credit_settlement_adjustment_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  settlement_row "billing_credit_usage_settlements"%ROWTYPE;
  snapshot_row "billing_credit_portfolio_snapshots"%ROWTYPE;
  entry_row "billing_credit_entries"%ROWTYPE;
  expected_kind "BillingCreditEntryKind";
  expected_direction "BillingCreditEntryDirection";
  next_sequence INTEGER;
  previous_snapshot_id TEXT;
  previous_snapshot_captured_at TIMESTAMP(3);
BEGIN
  SELECT * INTO settlement_row
  FROM "billing_credit_usage_settlements"
  WHERE "id" = NEW."settlement_id"
  FOR UPDATE;
  IF NOT FOUND
     OR settlement_row."account_id" <> NEW."account_id"
     OR settlement_row."credit_account_id" <> NEW."credit_account_id"
     OR settlement_row."service_id" <> NEW."service_id" THEN
    RAISE EXCEPTION 'settlement adjustment does not match its aggregate settlement'
      USING ERRCODE = '23514';
  END IF;
  PERFORM "billing_assert_credit_app_key_provenance"(NEW."app_key_id", true);
  SELECT * INTO snapshot_row
  FROM "billing_credit_portfolio_snapshots"
  WHERE "id" = NEW."portfolio_snapshot_id";
  IF NOT FOUND
     OR snapshot_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR snapshot_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
     OR snapshot_row."billing_month" IS DISTINCT FROM settlement_row."billing_month"
     OR snapshot_row."contract" IS DISTINCT FROM 'metering-portfolio-v1'
     OR snapshot_row."group_by" IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'settlement adjustment must use the exact team-wide user portfolio snapshot'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(max(adjustment."sequence"), 0) + 1 INTO next_sequence
  FROM "billing_credit_usage_settlement_adjustments" AS adjustment
  WHERE adjustment."settlement_id" = NEW."settlement_id";
  IF NEW."sequence" <> next_sequence THEN
    RAISE EXCEPTION 'settlement adjustment sequence does not continue the locked chain'
      USING ERRCODE = '40001';
  END IF;
  SELECT previous_snapshot."id", previous_snapshot."captured_at"
    INTO previous_snapshot_id, previous_snapshot_captured_at
  FROM "billing_credit_usage_settlement_adjustments" AS adjustment
  JOIN "billing_credit_portfolio_snapshots" AS previous_snapshot
    ON previous_snapshot."id" = adjustment."portfolio_snapshot_id"
  WHERE adjustment."settlement_id" = NEW."settlement_id"
  ORDER BY adjustment."sequence" DESC
  LIMIT 1;
  IF previous_snapshot_id IS NOT NULL
     AND snapshot_row."id" IS DISTINCT FROM previous_snapshot_id
     AND snapshot_row."captured_at" <= previous_snapshot_captured_at THEN
    RAISE EXCEPTION 'settlement adjustment cannot apply an older portfolio snapshot'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."cumulative_rated_usage_amount_micro_minor"
       <> settlement_row."cumulative_rated_usage_amount_micro_minor"
          + NEW."delta_rated_usage_amount_micro_minor"
     OR NEW."cumulative_credits_consumed_microcredits"
       <> settlement_row."cumulative_credits_consumed_microcredits"
          + NEW."delta_credits_consumed_microcredits"
     OR NEW."cumulative_remaining_usage_amount_micro_minor"
       <> settlement_row."cumulative_remaining_usage_amount_micro_minor"
          + NEW."delta_remaining_usage_amount_micro_minor" THEN
    RAISE EXCEPTION 'settlement adjustment does not continue the locked cumulative chain'
      USING ERRCODE = '40001';
  END IF;

  IF NEW."delta_credits_consumed_microcredits" <> 0 THEN
    SELECT * INTO entry_row FROM "billing_credit_entries"
      WHERE "id" = NEW."credit_entry_id";
    expected_kind := CASE
      WHEN settlement_row."cumulative_rated_usage_amount_micro_minor" = 0
       AND settlement_row."cumulative_credits_consumed_microcredits" = 0
       AND settlement_row."cumulative_remaining_usage_amount_micro_minor" = 0
        THEN 'USAGE_SETTLEMENT'::"BillingCreditEntryKind"
      ELSE 'USAGE_SETTLEMENT_CORRECTION'::"BillingCreditEntryKind"
    END;
    expected_direction := CASE
      WHEN NEW."delta_credits_consumed_microcredits" > 0
        THEN 'DEBIT'::"BillingCreditEntryDirection"
      ELSE 'CREDIT'::"BillingCreditEntryDirection"
    END;
    IF entry_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
       OR entry_row."service_id" IS DISTINCT FROM NEW."service_id"
       OR entry_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
       OR entry_row."attributed_user_id" IS NOT NULL
       OR entry_row."kind" IS DISTINCT FROM expected_kind
       OR entry_row."direction" IS DISTINCT FROM expected_direction
       OR entry_row."amount_microcredits"::numeric
          IS DISTINCT FROM abs(NEW."delta_credits_consumed_microcredits"::numeric)
       OR entry_row."source_type" IS DISTINCT FROM 'credit_usage_settlement_adjustment'
       OR entry_row."source_id" IS DISTINCT FROM NEW."id" THEN
      RAISE EXCEPTION 'settlement adjustment does not match its aggregate credit entry'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE "billing_credit_usage_settlements"
  SET "cumulative_rated_usage_amount_micro_minor" = NEW."cumulative_rated_usage_amount_micro_minor",
      "cumulative_credits_consumed_microcredits" = NEW."cumulative_credits_consumed_microcredits",
      "cumulative_remaining_usage_amount_micro_minor" = NEW."cumulative_remaining_usage_amount_micro_minor",
      "status" = 'APPLIED',
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."settlement_id";
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "billing_credit_usage_allocation_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  adjustment_row "billing_credit_usage_settlement_adjustments"%ROWTYPE;
  settlement_row "billing_credit_usage_settlements"%ROWTYPE;
  credit_row "billing_credit_accounts"%ROWTYPE;
  previous_row "billing_credit_usage_allocations"%ROWTYPE;
BEGIN
  SELECT * INTO adjustment_row
  FROM "billing_credit_usage_settlement_adjustments"
  WHERE "id" = NEW."adjustment_id";
  SELECT * INTO settlement_row
  FROM "billing_credit_usage_settlements"
  WHERE "id" = NEW."settlement_id"
  FOR KEY SHARE;
  SELECT * INTO credit_row FROM "billing_credit_accounts"
    WHERE "id" = settlement_row."credit_account_id";
  IF adjustment_row."settlement_id" IS DISTINCT FROM NEW."settlement_id"
     OR adjustment_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR adjustment_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
     OR settlement_row."service_id" IS DISTINCT FROM NEW."service_id" THEN
    RAISE EXCEPTION 'usage allocation does not match its aggregate adjustment'
      USING ERRCODE = '23514';
  END IF;
  PERFORM "billing_assert_credit_app_key_provenance"(NEW."app_key_id", true);
  IF NEW."attributed_user_id" IS NOT NULL THEN
    PERFORM "billing_assert_credit_team_user"(
      credit_row."team_id", NEW."attributed_user_id", false
    );
  END IF;

  SELECT allocation.* INTO previous_row
  FROM "billing_credit_usage_allocations" AS allocation
  JOIN "billing_credit_usage_settlement_adjustments" AS adjustment
    ON adjustment."id" = allocation."adjustment_id"
  WHERE allocation."settlement_id" = NEW."settlement_id"
    AND allocation."adjustment_id" <> NEW."adjustment_id"
    AND allocation."attributed_user_id" IS NOT DISTINCT FROM NEW."attributed_user_id"
    AND adjustment."sequence" < adjustment_row."sequence"
  ORDER BY adjustment."sequence" DESC
  LIMIT 1;

  IF NEW."cumulative_rated_usage_amount_micro_minor"
       <> COALESCE(previous_row."cumulative_rated_usage_amount_micro_minor", 0)
          + NEW."delta_rated_usage_amount_micro_minor"
     OR NEW."cumulative_credits_consumed_microcredits"
       <> COALESCE(previous_row."cumulative_credits_consumed_microcredits", 0)
          + NEW."delta_credits_consumed_microcredits"
     OR NEW."cumulative_remaining_usage_amount_micro_minor"
       <> COALESCE(previous_row."cumulative_remaining_usage_amount_micro_minor", 0)
          + NEW."delta_remaining_usage_amount_micro_minor" THEN
    RAISE EXCEPTION 'usage allocation does not continue its per-user cumulative chain'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;

-- A new immutable cursor may carry an identical aggregate or only move user
-- attribution. It still needs an at-most-once adjustment row; exact deferred
-- allocation totals continue to prove the zero-sum correction.
ALTER TABLE "billing_credit_usage_settlement_adjustments"
  DROP CONSTRAINT "billing_credit_usage_settlement_adjustments_delta_check";
ALTER TABLE "billing_credit_usage_settlement_adjustments"
  ADD CONSTRAINT "billing_credit_usage_settlement_adjustments_delta_check" CHECK (
    "delta_remaining_usage_amount_micro_minor"::numeric * 10
      = "delta_rated_usage_amount_micro_minor"::numeric * 10
        - "delta_credits_consumed_microcredits"::numeric
    AND (
      ("delta_credits_consumed_microcredits" = 0 AND "credit_entry_id" IS NULL)
      OR ("delta_credits_consumed_microcredits" <> 0 AND "credit_entry_id" IS NOT NULL)
    )
  );
