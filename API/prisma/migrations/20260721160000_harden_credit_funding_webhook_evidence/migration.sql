-- Preserve the exact Stripe event that most recently proved an automatic
-- top-up's non-success state. Raw events remain immutable; replacement is only
-- allowed by an equally new or newer event for the same PaymentIntent.
ALTER TABLE "billing_stripe_webhook_events"
  ADD COLUMN "stripe_object_status" VARCHAR(80);

ALTER TABLE "billing_credit_auto_top_up_attempts"
  ADD COLUMN "state_webhook_event_id" TEXT;

CREATE UNIQUE INDEX "billing_credit_auto_top_up_attempts_state_event_key"
  ON "billing_credit_auto_top_up_attempts"("state_webhook_event_id");

ALTER TABLE "billing_credit_auto_top_up_attempts"
  ADD CONSTRAINT "billing_credit_auto_top_up_attempts_state_event_fkey"
  FOREIGN KEY ("state_webhook_event_id")
  REFERENCES "billing_stripe_webhook_events"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_credit_auto_top_up_attempts"
  DROP CONSTRAINT "billing_credit_auto_top_up_attempts_completion_check",
  ADD CONSTRAINT "billing_credit_auto_top_up_attempts_completion_check" CHECK (
    (
      "status" = 'SUCCEEDED'
      AND "stripe_payment_intent_id" IS NOT NULL
      AND "success_webhook_event_id" IS NOT NULL
      AND "credit_entry_id" IS NOT NULL
      AND "resolved_at" IS NOT NULL
    )
    OR (
      "status" = 'FAILED'
      AND "stripe_payment_intent_id" IS NOT NULL
      AND "success_webhook_event_id" IS NULL
      AND "state_webhook_event_id" IS NOT NULL
      AND "credit_entry_id" IS NULL
      AND "resolved_at" IS NOT NULL
      AND length(btrim("failure_code")) > 0
    )
    OR (
      "status" = 'CANCELED'
      AND "stripe_payment_intent_id" IS NOT NULL
      AND "state_webhook_event_id" IS NOT NULL
      AND "credit_entry_id" IS NULL
      AND "success_webhook_event_id" IS NULL
      AND "resolved_at" IS NOT NULL
    )
    OR (
      "status" = 'NEEDS_REVIEW'
      AND "credit_entry_id" IS NULL
      AND "success_webhook_event_id" IS NULL
      AND "resolved_at" IS NULL
    )
    OR (
      "status" IN ('PROCESSING', 'REQUIRES_ACTION')
      AND "stripe_payment_intent_id" IS NOT NULL
      AND "state_webhook_event_id" IS NOT NULL
      AND "credit_entry_id" IS NULL
      AND "success_webhook_event_id" IS NULL
      AND "resolved_at" IS NULL
    )
    OR (
      "status" = 'PENDING'
      AND "credit_entry_id" IS NULL
      AND "success_webhook_event_id" IS NULL
      AND "state_webhook_event_id" IS NULL
      AND "resolved_at" IS NULL
    )
  );

CREATE FUNCTION "billing_credit_auto_top_up_state_evidence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  webhook_row "billing_stripe_webhook_events"%ROWTYPE;
  previous_webhook_row "billing_stripe_webhook_events"%ROWTYPE;
  credit_row "billing_credit_accounts"%ROWTYPE;
  customer_row "billing_stripe_customers"%ROWTYPE;
  revision_row "billing_credit_auto_top_up_consent_revisions"%ROWTYPE;
  account_livemode BOOLEAN;
BEGIN
  IF OLD."state_webhook_event_id" IS NOT NULL
     AND NEW."state_webhook_event_id" IS NULL THEN
    RAISE EXCEPTION 'automatic top-up state evidence cannot be removed'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('SUCCEEDED', 'FAILED', 'CANCELED')
     AND NEW."state_webhook_event_id" IS DISTINCT FROM OLD."state_webhook_event_id" THEN
    RAISE EXCEPTION 'terminal automatic top-up state evidence is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."state_webhook_event_id" IS NOT NULL THEN
    SELECT * INTO webhook_row FROM "billing_stripe_webhook_events"
      WHERE "id" = NEW."state_webhook_event_id";
    SELECT * INTO credit_row FROM "billing_credit_accounts"
      WHERE "id" = NEW."credit_account_id";
    SELECT * INTO customer_row FROM "billing_stripe_customers"
      WHERE "id" = credit_row."customer_id";
    SELECT * INTO revision_row FROM "billing_credit_auto_top_up_consent_revisions"
      WHERE "id" = NEW."consent_revision_id";
    SELECT "livemode" INTO account_livemode FROM "billing_stripe_accounts"
      WHERE "id" = NEW."account_id";
    IF webhook_row."id" IS NULL
       OR webhook_row."type" NOT IN (
         'payment_intent.payment_failed',
         'payment_intent.processing',
         'payment_intent.requires_action',
         'payment_intent.canceled'
       )
       OR webhook_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR webhook_row."livemode" IS DISTINCT FROM account_livemode
       OR webhook_row."stripe_object_id" IS DISTINCT FROM NEW."stripe_payment_intent_id"
       OR webhook_row."stripe_payment_intent_id" IS DISTINCT FROM NEW."stripe_payment_intent_id"
       OR webhook_row."stripe_customer_id" IS DISTINCT FROM customer_row."stripe_customer_id"
       OR webhook_row."stripe_payment_method_id" IS DISTINCT FROM revision_row."stripe_payment_method_id"
       OR webhook_row."amount_minor" IS DISTINCT FROM NEW."payment_amount_minor"
       OR webhook_row."currency" IS DISTINCT FROM 'USD'
       OR (
         webhook_row."type" = 'payment_intent.processing'
         AND webhook_row."stripe_object_status" IS DISTINCT FROM 'processing'
       )
       OR (
         webhook_row."type" = 'payment_intent.requires_action'
         AND webhook_row."stripe_object_status" IS DISTINCT FROM 'requires_action'
       )
       OR (
         webhook_row."type" = 'payment_intent.canceled'
         AND webhook_row."stripe_object_status" IS DISTINCT FROM 'canceled'
       )
       OR (
         webhook_row."type" = 'payment_intent.payment_failed'
         AND (
           webhook_row."stripe_object_status" IS NULL
           OR webhook_row."stripe_object_status" IN ('succeeded', 'processing', 'canceled')
         )
       ) THEN
      RAISE EXCEPTION 'automatic top-up lacks exact Stripe state evidence'
        USING ERRCODE = '23514';
    END IF;

    IF NEW."status" <> 'SUCCEEDED'
       AND NOT (
         (webhook_row."type" = 'payment_intent.payment_failed'
           AND NEW."status" IN ('NEEDS_REVIEW', 'FAILED'))
         OR (webhook_row."type" = 'payment_intent.processing'
           AND NEW."status" = 'PROCESSING')
         OR (webhook_row."type" = 'payment_intent.requires_action'
           AND NEW."status" IN ('REQUIRES_ACTION', 'NEEDS_REVIEW'))
         OR (webhook_row."type" = 'payment_intent.canceled'
           AND NEW."status" IN ('CANCELED', 'NEEDS_REVIEW'))
       ) THEN
      RAISE EXCEPTION 'automatic top-up state does not match its Stripe event'
        USING ERRCODE = '23514';
    END IF;

    IF OLD."state_webhook_event_id" IS NOT NULL
       AND NEW."state_webhook_event_id" IS DISTINCT FROM OLD."state_webhook_event_id" THEN
      SELECT * INTO previous_webhook_row FROM "billing_stripe_webhook_events"
        WHERE "id" = OLD."state_webhook_event_id";
      IF previous_webhook_row."stripe_created_at" > webhook_row."stripe_created_at"
         OR (
           previous_webhook_row."stripe_created_at" = webhook_row."stripe_created_at"
           AND previous_webhook_row."received_at" > webhook_row."received_at"
         ) THEN
        RAISE EXCEPTION 'older Stripe state evidence cannot replace newer evidence'
          USING ERRCODE = '23514';
      END IF;
      IF previous_webhook_row."stripe_created_at" = webhook_row."stripe_created_at"
         AND previous_webhook_row."type" IN (
           'payment_intent.processing', 'payment_intent.requires_action'
         )
         AND webhook_row."type" IN (
           'payment_intent.processing', 'payment_intent.requires_action'
         )
         AND previous_webhook_row."type" <> webhook_row."type" THEN
        NEW."status" := 'NEEDS_REVIEW';
        NEW."failure_code" := 'ambiguous_stripe_event_order';
        NEW."resolved_at" := NULL;
        UPDATE "billing_credit_accounts"
        SET "auto_top_up_state" = 'NEEDS_REVIEW', "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = NEW."credit_account_id" AND "auto_top_up_state" <> 'DISABLED';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_auto_top_up_state_evidence"
  BEFORE UPDATE ON "billing_credit_auto_top_up_attempts"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_auto_top_up_state_evidence"();

-- Consent and payment-method changes cannot race an unresolved off-session
-- PaymentIntent. This keeps every event bound to one immutable consent revision.
CREATE FUNCTION "billing_credit_block_consent_change_during_attempt"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
       NEW."auto_top_up_policy_id", NEW."auto_top_up_service_id",
       NEW."auto_top_up_app_key_id", NEW."auto_top_up_consent_revision_id",
       NEW."auto_top_up_option_id", NEW."auto_top_up_threshold_microcredits",
       NEW."auto_top_up_refill_offer_id", NEW."auto_top_up_monthly_charge_cap_minor",
       NEW."auto_top_up_consent_version", NEW."auto_top_up_consented_at",
       NEW."auto_top_up_consented_by_user_id", NEW."stripe_payment_method_id",
       NEW."payment_method_summary"
     ) IS DISTINCT FROM ROW(
       OLD."auto_top_up_policy_id", OLD."auto_top_up_service_id",
       OLD."auto_top_up_app_key_id", OLD."auto_top_up_consent_revision_id",
       OLD."auto_top_up_option_id", OLD."auto_top_up_threshold_microcredits",
       OLD."auto_top_up_refill_offer_id", OLD."auto_top_up_monthly_charge_cap_minor",
       OLD."auto_top_up_consent_version", OLD."auto_top_up_consented_at",
       OLD."auto_top_up_consented_by_user_id", OLD."stripe_payment_method_id",
       OLD."payment_method_summary"
     )
     AND EXISTS (
       SELECT 1 FROM "billing_credit_auto_top_up_attempts" AS attempt
       WHERE attempt."credit_account_id" = NEW."id"
         AND attempt."status" IN ('PENDING', 'PROCESSING', 'REQUIRES_ACTION', 'NEEDS_REVIEW')
     ) THEN
    RAISE EXCEPTION 'automatic top-up consent cannot change while a payment is unresolved'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_accounts_block_unresolved_consent_change"
  BEFORE UPDATE ON "billing_credit_accounts"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_block_consent_change_during_attempt"();
