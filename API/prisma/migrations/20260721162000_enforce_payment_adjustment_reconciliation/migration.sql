CREATE OR REPLACE FUNCTION "billing_credit_payment_adjustment_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_row "billing_credit_accounts"%ROWTYPE;
  source_row "billing_credit_entries"%ROWTYPE;
  webhook_row "billing_stripe_webhook_events"%ROWTYPE;
  account_livemode BOOLEAN;
  original_payment_intent_id TEXT;
  active_before NUMERIC;
  active_after NUMERIC;
  applied_before NUMERIC;
  desired_before NUMERIC;
  desired_after NUMERIC;
  object_active NUMERIC;
  expected_delta NUMERIC;
  reversal BOOLEAN;
BEGIN
  reversal := NEW."kind" IN ('REFUND_REVERSAL', 'DISPUTE_REVERSAL');
  SELECT * INTO source_row FROM "billing_credit_entries"
    WHERE "id" = NEW."original_entry_id" FOR UPDATE;
  SELECT * INTO account_row FROM "billing_credit_accounts"
    WHERE "id" = NEW."credit_account_id";
  SELECT * INTO webhook_row FROM "billing_stripe_webhook_events"
    WHERE "id" = NEW."webhook_event_id";
  SELECT "livemode" INTO account_livemode FROM "billing_stripe_accounts"
    WHERE "id" = NEW."account_id";
  IF source_row."kind" = 'TOP_UP' THEN
    SELECT checkout."stripe_payment_intent_id" INTO original_payment_intent_id
    FROM "billing_credit_top_up_checkouts" AS checkout
    WHERE checkout."credit_entry_id" = source_row."id" AND checkout."status" = 'COMPLETE';
  ELSIF source_row."kind" = 'AUTOMATIC_TOP_UP' THEN
    SELECT attempt."stripe_payment_intent_id" INTO original_payment_intent_id
    FROM "billing_credit_auto_top_up_attempts" AS attempt
    WHERE attempt."credit_entry_id" = source_row."id" AND attempt."status" = 'SUCCEEDED';
  END IF;

  PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");
  IF source_row."id" IS NULL
     OR account_row."id" IS NULL
     OR webhook_row."id" IS NULL
     OR source_row."kind" NOT IN ('TOP_UP', 'AUTOMATIC_TOP_UP')
     OR source_row."direction" <> 'CREDIT'
     OR source_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
     OR source_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR source_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
     OR account_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR original_payment_intent_id IS DISTINCT FROM NEW."stripe_payment_intent_id"
     OR webhook_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR webhook_row."livemode" IS DISTINCT FROM NEW."livemode"
     OR webhook_row."stripe_object_id" IS DISTINCT FROM NEW."stripe_object_id"
     OR webhook_row."stripe_payment_intent_id" IS DISTINCT FROM NEW."stripe_payment_intent_id"
     OR webhook_row."stripe_charge_id" IS DISTINCT FROM NEW."stripe_charge_id"
     OR webhook_row."amount_minor" IS DISTINCT FROM NEW."amount_minor"
     OR webhook_row."currency" IS DISTINCT FROM NEW."currency"
     OR webhook_row."stripe_created_at" IS DISTINCT FROM NEW."occurred_at"
     OR account_livemode IS DISTINCT FROM NEW."livemode"
     OR (NEW."kind" = 'REFUND' AND (
       webhook_row."type" NOT IN ('refund.created', 'refund.updated')
       OR webhook_row."stripe_object_status" IS DISTINCT FROM 'succeeded'
     ))
     OR (NEW."kind" = 'REFUND_REVERSAL' AND (
       webhook_row."type" NOT IN ('refund.created', 'refund.updated', 'refund.failed')
       OR webhook_row."stripe_object_status" IS NULL
       OR webhook_row."stripe_object_status" NOT IN ('failed', 'canceled')
     ))
     OR (NEW."kind" = 'DISPUTE' AND webhook_row."type" <> 'charge.dispute.funds_withdrawn')
     OR (NEW."kind" = 'DISPUTE_REVERSAL'
       AND webhook_row."type" <> 'charge.dispute.funds_reinstated') THEN
    RAISE EXCEPTION 'Stripe payment adjustment evidence is not exact'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(GREATEST(
      base."amount_minor"::numeric * 10000000
      - COALESCE((
        SELECT MAX(restored."amount_minor"::numeric * 10000000)
        FROM "billing_credit_payment_adjustments" AS restored
        WHERE restored."original_entry_id" = source_row."id"
          AND restored."stripe_object_id" = base."stripe_object_id"
          AND restored."kind" = (CASE base."kind"
            WHEN 'REFUND' THEN 'REFUND_REVERSAL'::"BillingCreditPaymentAdjustmentKind"
            ELSE 'DISPUTE_REVERSAL'::"BillingCreditPaymentAdjustmentKind"
          END)
      ), 0),
      0
    )), 0)
    INTO active_before
  FROM "billing_credit_payment_adjustments" AS base
  WHERE base."original_entry_id" = source_row."id"
    AND base."kind" IN ('REFUND', 'DISPUTE');
  SELECT COALESCE(SUM(CASE
      WHEN adjustment."kind" IN ('REFUND', 'DISPUTE') THEN adjustment."amount_microcredits"
      ELSE -adjustment."amount_microcredits"
    END), 0)
    INTO applied_before
  FROM "billing_credit_payment_adjustments" AS adjustment
  WHERE adjustment."original_entry_id" = source_row."id";
  desired_before := LEAST(source_row."amount_microcredits"::numeric, active_before);
  IF applied_before IS DISTINCT FROM desired_before THEN
    RAISE EXCEPTION 'existing Stripe payment adjustment reconciliation is inconsistent'
      USING ERRCODE = '23514';
  END IF;

  active_after := active_before;
  IF reversal THEN
    SELECT COALESCE(MAX(GREATEST(
        base."amount_minor"::numeric * 10000000
        - COALESCE((
          SELECT MAX(restored."amount_minor"::numeric * 10000000)
          FROM "billing_credit_payment_adjustments" AS restored
          WHERE restored."original_entry_id" = source_row."id"
            AND restored."stripe_object_id" = base."stripe_object_id"
            AND restored."kind" = NEW."kind"
        ), 0),
        0
      )), 0)
      INTO object_active
    FROM "billing_credit_payment_adjustments" AS base
    WHERE base."original_entry_id" = source_row."id"
      AND base."stripe_object_id" = NEW."stripe_object_id"
      AND base."kind" = (CASE NEW."kind"
        WHEN 'REFUND_REVERSAL' THEN 'REFUND'::"BillingCreditPaymentAdjustmentKind"
        ELSE 'DISPUTE'::"BillingCreditPaymentAdjustmentKind"
      END);
    active_after := active_before - LEAST(
      object_active,
      NEW."amount_minor"::numeric * 10000000
    );
  ELSE
    SELECT COALESCE(MAX(restored."amount_minor"::numeric * 10000000), 0)
      INTO object_active
    FROM "billing_credit_payment_adjustments" AS restored
    WHERE restored."original_entry_id" = source_row."id"
      AND restored."stripe_object_id" = NEW."stripe_object_id"
      AND restored."kind" = (CASE NEW."kind"
        WHEN 'REFUND' THEN 'REFUND_REVERSAL'::"BillingCreditPaymentAdjustmentKind"
        ELSE 'DISPUTE_REVERSAL'::"BillingCreditPaymentAdjustmentKind"
      END);
    active_after := active_before + GREATEST(
      NEW."amount_minor"::numeric * 10000000 - object_active,
      0
    );
  END IF;
  desired_after := LEAST(source_row."amount_microcredits"::numeric, active_after);
  expected_delta := desired_after - desired_before;
  IF (reversal AND expected_delta > 0)
     OR (NOT reversal AND expected_delta < 0)
     OR NEW."amount_microcredits"::numeric <> abs(expected_delta) THEN
    RAISE EXCEPTION 'Stripe payment adjustment delta is not the deterministic paid principal change'
      USING ERRCODE = '23514';
  END IF;

  UPDATE "billing_credit_accounts"
  SET "auto_top_up_state" = 'NEEDS_REVIEW', "updated_at" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."credit_account_id" AND "auto_top_up_state" <> 'DISABLED';
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "billing_credit_payment_adjustment_entry_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_row "billing_credit_entries"%ROWTYPE;
  entry_row "billing_credit_entries"%ROWTYPE;
  expected_direction "BillingCreditEntryDirection";
BEGIN
  IF NEW."amount_microcredits" = 0 THEN
    IF NEW."credit_entry_id" IS NOT NULL THEN
      RAISE EXCEPTION 'zero-delta Stripe adjustment cannot reference a credit entry'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO source_row FROM "billing_credit_entries" WHERE "id" = NEW."original_entry_id";
  SELECT * INTO entry_row FROM "billing_credit_entries" WHERE "id" = NEW."credit_entry_id";
  expected_direction := CASE WHEN NEW."kind" IN ('REFUND_REVERSAL', 'DISPUTE_REVERSAL')
    THEN 'CREDIT'::"BillingCreditEntryDirection" ELSE 'DEBIT'::"BillingCreditEntryDirection" END;
  IF entry_row."id" IS NULL
     OR entry_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
     OR entry_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR entry_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
     OR entry_row."attributed_user_id" IS DISTINCT FROM source_row."attributed_user_id"
     OR entry_row."kind"::text IS DISTINCT FROM NEW."kind"::text
     OR entry_row."direction" IS DISTINCT FROM expected_direction
     OR entry_row."amount_microcredits" IS DISTINCT FROM NEW."amount_microcredits"
     OR entry_row."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
     OR entry_row."source_type" IS DISTINCT FROM 'credit_payment_adjustment'
     OR entry_row."source_id" IS DISTINCT FROM NEW."id"
     OR entry_row."reverses_entry_id" IS DISTINCT FROM NEW."original_entry_id" THEN
    RAISE EXCEPTION 'Stripe payment adjustment must commit with one exact entry'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

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
  ELSE
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
  IF NEW."kind" IN ('USAGE_SETTLEMENT', 'USAGE_SETTLEMENT_CORRECTION')
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
  IF NEW."kind" = 'TOP_UP' AND NOT EXISTS (
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
