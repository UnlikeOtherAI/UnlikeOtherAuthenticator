-- Refunds and disputes of a GBP or EUR purchase. The refunded money buys back
-- credits at the purchase's own terms (what it paid for what it granted), so a
-- refund of what is left of a lot, in its currency, empties that lot; the lot
-- trigger already draws a refund from its own purchase's lot first. A USD
-- purchase grants 10,000,000 microcredits per cent, so its refunds are as before.

ALTER TABLE "billing_credit_payment_adjustments"
  DROP CONSTRAINT "billing_credit_payment_adjustments_values_check",
  ADD CONSTRAINT "billing_credit_payment_adjustments_values_check" CHECK (
    "currency" IN ('USD', 'EUR', 'GBP')
    AND "amount_minor" > 0
    AND "amount_microcredits" >= 0
    AND (("currency" = 'USD'
        AND "amount_microcredits"::numeric <= "amount_minor"::numeric * 10000000
        AND "amount_microcredits" % 10000000 = 0)
      OR ("currency" <> 'USD' AND "amount_microcredits" % 1000000 = 0))
    AND (
      ("amount_microcredits" = 0 AND "credit_entry_id" IS NULL)
      OR ("amount_microcredits" > 0 AND "credit_entry_id" IS NOT NULL)
    )
    AND length(btrim("idempotency_key")) > 0
    AND "stripe_payment_intent_id" ~ '^pi_[A-Za-z0-9_-]+$'
    AND "stripe_charge_id" ~ '^ch_[A-Za-z0-9_-]+$'
    AND (
      ("kind" IN ('REFUND', 'REFUND_REVERSAL') AND "stripe_object_id" ~ '^re_[A-Za-z0-9_-]+$')
      OR ("kind" IN ('DISPUTE', 'DISPUTE_REVERSAL') AND "stripe_object_id" ~ '^dp_[A-Za-z0-9_-]+$')
    )
  );

CREATE OR REPLACE FUNCTION "billing_credit_payment_adjustment_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_row "billing_credit_accounts"%ROWTYPE;
  source_row "billing_credit_entries"%ROWTYPE;
  webhook_row "billing_stripe_webhook_events"%ROWTYPE;
  account_livemode BOOLEAN;
  original_payment_intent_id TEXT;
  purchase_currency TEXT;
  purchase_minor NUMERIC;
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
    SELECT checkout."stripe_payment_intent_id", checkout."currency", checkout."payment_amount_minor"
      INTO original_payment_intent_id, purchase_currency, purchase_minor
    FROM "billing_credit_top_up_checkouts" AS checkout
    WHERE checkout."credit_entry_id" = source_row."id" AND checkout."status" = 'COMPLETE';
  ELSIF source_row."kind" = 'AUTOMATIC_TOP_UP' THEN
    SELECT attempt."stripe_payment_intent_id", attempt."currency", attempt."payment_amount_minor"
      INTO original_payment_intent_id, purchase_currency, purchase_minor
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
     -- A refund or dispute is in the currency the purchase was paid in.
     OR purchase_currency IS DISTINCT FROM NEW."currency"
     OR COALESCE(purchase_minor <= 0, true)
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
      base."amount_minor"::numeric
      - COALESCE((
        SELECT MAX(restored."amount_minor"::numeric)
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
  -- Principal is money in the purchase currency; it buys back credits at the
  -- purchase's own terms (what it paid for what it granted), in whole credits.
  -- A USD purchase granted 10,000,000 microcredits per cent, as before.
  desired_before := LEAST(source_row."amount_microcredits"::numeric,
    floor(active_before * source_row."amount_microcredits" / (purchase_minor * 1000000)) * 1000000);
  IF applied_before IS DISTINCT FROM desired_before THEN
    RAISE EXCEPTION 'existing Stripe payment adjustment reconciliation is inconsistent'
      USING ERRCODE = '23514';
  END IF;

  active_after := active_before;
  IF reversal THEN
    SELECT COALESCE(MAX(GREATEST(
        base."amount_minor"::numeric
        - COALESCE((
          SELECT MAX(restored."amount_minor"::numeric)
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
      NEW."amount_minor"::numeric
    );
  ELSE
    SELECT COALESCE(MAX(restored."amount_minor"::numeric), 0)
      INTO object_active
    FROM "billing_credit_payment_adjustments" AS restored
    WHERE restored."original_entry_id" = source_row."id"
      AND restored."stripe_object_id" = NEW."stripe_object_id"
      AND restored."kind" = (CASE NEW."kind"
        WHEN 'REFUND' THEN 'REFUND_REVERSAL'::"BillingCreditPaymentAdjustmentKind"
        ELSE 'DISPUTE_REVERSAL'::"BillingCreditPaymentAdjustmentKind"
      END);
    active_after := active_before + GREATEST(
      NEW."amount_minor"::numeric - object_active,
      0
    );
  END IF;
  desired_after := LEAST(source_row."amount_microcredits"::numeric,
    floor(active_after * source_row."amount_microcredits" / (purchase_minor * 1000000)) * 1000000);
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
