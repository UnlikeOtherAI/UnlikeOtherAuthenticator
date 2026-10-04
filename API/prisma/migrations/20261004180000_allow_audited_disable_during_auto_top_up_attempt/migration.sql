-- An audited disable may clear the current consent while an older attempt is
-- unresolved. That attempt remains immutable and settles only from its own
-- exact payment evidence; the disable never authorizes a replacement payment.
CREATE OR REPLACE FUNCTION "billing_credit_block_consent_change_during_attempt"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  snapshot_changed BOOLEAN;
  authorized_disable BOOLEAN;
BEGIN
  snapshot_changed := ROW(
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
  );
  IF snapshot_changed AND EXISTS (
    SELECT 1 FROM "billing_credit_auto_top_up_attempts" AS attempt
    WHERE attempt."credit_account_id" = NEW."id"
      AND attempt."status" IN ('PENDING', 'PROCESSING', 'REQUIRES_ACTION', 'NEEDS_REVIEW')
  ) THEN
    authorized_disable :=
      OLD."auto_top_up_state" <> 'DISABLED'
      AND NEW."auto_top_up_state" = 'DISABLED'
      AND NEW."auto_top_up_generation" = OLD."auto_top_up_generation" + 1
      AND ROW(
        NEW."auto_top_up_policy_id", NEW."auto_top_up_service_id",
        NEW."auto_top_up_app_key_id", NEW."auto_top_up_consent_revision_id",
        NEW."auto_top_up_option_id", NEW."auto_top_up_threshold_microcredits",
        NEW."auto_top_up_refill_offer_id", NEW."auto_top_up_monthly_charge_cap_minor",
        NEW."auto_top_up_consent_version", NEW."auto_top_up_consented_at",
        NEW."auto_top_up_consented_by_user_id", NEW."stripe_payment_method_id",
        NEW."payment_method_summary"
      ) IS NULL
      AND EXISTS (
        SELECT 1
        FROM "billing_credit_auto_top_up_disable_events" AS disable_event
        JOIN "billing_customer_action_intents" AS action_intent
          ON action_intent."app_key_id" = disable_event."app_key_id"
         AND action_intent."service_id" = disable_event."service_id"
         AND action_intent."org_id" = disable_event."org_id"
         AND action_intent."requested_by_user_id" = disable_event."requested_by_user_id"
         AND action_intent."actor_jti" = disable_event."actor_jti"
         AND action_intent."operation" = 'credit_auto_top_up_disable'
        WHERE disable_event."credit_account_id" = OLD."id"
          AND disable_event."account_id" = OLD."account_id"
          AND disable_event."org_id" = OLD."org_id"
          AND disable_event."team_id" IS NOT DISTINCT FROM OLD."team_id"
          AND disable_event."service_id" = OLD."auto_top_up_service_id"
          AND disable_event."previous_generation" = OLD."auto_top_up_generation"
          AND disable_event."previous_consent_revision_id"
            IS NOT DISTINCT FROM OLD."auto_top_up_consent_revision_id"
      );
    IF NOT authorized_disable THEN
      RAISE EXCEPTION 'automatic top-up consent cannot change while a payment is unresolved'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Keep the generation guard's disable proof aligned with the attempt guard
-- above. Team-scoped accounts still require the same team; org-scoped accounts
-- match only another NULL team_id from their exact audited disable event.
CREATE OR REPLACE FUNCTION "billing_credit_auto_top_up_generation_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  snapshot_changed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."auto_top_up_generation" <> 0 THEN
      RAISE EXCEPTION 'new credit account generation must begin at zero'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  snapshot_changed := ROW(
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
  );
  IF snapshot_changed AND NEW."auto_top_up_generation" <> OLD."auto_top_up_generation" + 1 THEN
    RAISE EXCEPTION 'automatic top-up consent change must advance generation once'
      USING ERRCODE = '23514';
  ELSIF NOT snapshot_changed
     AND NEW."auto_top_up_generation" <> OLD."auto_top_up_generation" THEN
    RAISE EXCEPTION 'automatic top-up generation changed without a consent change'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."auto_top_up_state" <> 'DISABLED' AND NEW."auto_top_up_state" = 'DISABLED'
     AND NOT EXISTS (
       SELECT 1
       FROM "billing_credit_auto_top_up_disable_events" AS disable_event
       WHERE disable_event."credit_account_id" = OLD."id"
         AND disable_event."account_id" = OLD."account_id"
         AND disable_event."org_id" = OLD."org_id"
         AND disable_event."team_id" IS NOT DISTINCT FROM OLD."team_id"
         AND disable_event."previous_generation" = OLD."auto_top_up_generation"
         AND disable_event."previous_consent_revision_id"
           IS NOT DISTINCT FROM OLD."auto_top_up_consent_revision_id"
     ) THEN
    RAISE EXCEPTION 'automatic top-up disable requires manager-audited evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Let only the original attempt continue from verified Stripe events after an
-- audited disable. Its immutable consent/catalog/money snapshot and all existing
-- webhook and credit-entry proof checks remain in force.
CREATE OR REPLACE FUNCTION "billing_credit_auto_top_up_attempt_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_row "billing_credit_accounts"%ROWTYPE;
  customer_row "billing_stripe_customers"%ROWTYPE;
  success_event_row "billing_stripe_webhook_events"%ROWTYPE;
  policy_row "billing_credit_funding_policies"%ROWTYPE;
  revision_row "billing_credit_auto_top_up_consent_revisions"%ROWTYPE;
  option_row "billing_credit_auto_top_up_options"%ROWTYPE;
  offer_row "billing_credit_top_up_offers"%ROWTYPE;
  catalog_row "billing_credit_top_up_catalogs"%ROWTYPE;
  trigger_row "billing_credit_entries"%ROWTYPE;
  entry_row "billing_credit_entries"%ROWTYPE;
  charged_before_minor BIGINT;
  account_livemode BOOLEAN;
  authorized_disabled_attempt_update BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."billing_month" := to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM');
    NEW."created_at" := CURRENT_TIMESTAMP;
    IF NEW."status" IS DISTINCT FROM 'PENDING'
       OR NEW."stripe_payment_intent_id" IS NOT NULL
       OR NEW."success_webhook_event_id" IS NOT NULL
       OR NEW."credit_entry_id" IS NOT NULL
       OR NEW."resolved_at" IS NOT NULL THEN
      RAISE EXCEPTION 'new automatic top-up attempts must begin pending without payment proof'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO credit_row FROM "billing_credit_accounts"
    WHERE "id" = NEW."credit_account_id" FOR UPDATE;
  SELECT * INTO customer_row FROM "billing_stripe_customers"
    WHERE "id" = credit_row."customer_id";
  SELECT "livemode" INTO account_livemode FROM "billing_stripe_accounts"
    WHERE "id" = NEW."account_id";
  SELECT * INTO option_row FROM "billing_credit_auto_top_up_options"
    WHERE "id" = NEW."option_id";
  SELECT * INTO policy_row FROM "billing_credit_funding_policies"
    WHERE "id" = option_row."policy_id";
  SELECT * INTO revision_row FROM "billing_credit_auto_top_up_consent_revisions"
    WHERE "id" = NEW."consent_revision_id";
  SELECT * INTO offer_row FROM "billing_credit_top_up_offers"
    WHERE "id" = NEW."offer_id";
  SELECT * INTO catalog_row FROM "billing_credit_top_up_catalogs"
    WHERE "id" = NEW."catalog_id";
  PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");

  IF TG_OP = 'UPDATE' THEN
    authorized_disabled_attempt_update :=
      OLD."status" IN ('PENDING', 'PROCESSING', 'REQUIRES_ACTION', 'NEEDS_REVIEW')
      AND NEW."status" IN ('SUCCEEDED', 'FAILED', 'CANCELED', 'PROCESSING', 'REQUIRES_ACTION', 'NEEDS_REVIEW')
      AND NEW."consent_revision_id" = OLD."consent_revision_id"
      AND NEW."stripe_payment_intent_id" IS NOT NULL
      AND (
        (NEW."status" = 'SUCCEEDED' AND NEW."success_webhook_event_id" IS NOT NULL)
        OR (NEW."status" <> 'SUCCEEDED' AND NEW."state_webhook_event_id" IS NOT NULL)
      )
      AND credit_row."auto_top_up_state" = 'DISABLED'
      AND ROW(
        credit_row."auto_top_up_policy_id", credit_row."auto_top_up_service_id",
        credit_row."auto_top_up_app_key_id", credit_row."auto_top_up_consent_revision_id",
        credit_row."auto_top_up_option_id", credit_row."auto_top_up_threshold_microcredits",
        credit_row."auto_top_up_refill_offer_id", credit_row."auto_top_up_monthly_charge_cap_minor",
        credit_row."auto_top_up_consent_version", credit_row."auto_top_up_consented_at",
        credit_row."auto_top_up_consented_by_user_id", credit_row."stripe_payment_method_id",
        credit_row."payment_method_summary"
      ) IS NULL
      AND EXISTS (
        SELECT 1
        FROM "billing_credit_auto_top_up_disable_events" AS disable_event
        JOIN "billing_customer_action_intents" AS action_intent
          ON action_intent."app_key_id" = disable_event."app_key_id"
         AND action_intent."service_id" = disable_event."service_id"
         AND action_intent."org_id" = disable_event."org_id"
         AND action_intent."requested_by_user_id" = disable_event."requested_by_user_id"
         AND action_intent."actor_jti" = disable_event."actor_jti"
         AND action_intent."operation" = 'credit_auto_top_up_disable'
        WHERE disable_event."credit_account_id" = NEW."credit_account_id"
          AND disable_event."account_id" = NEW."account_id"
          AND disable_event."org_id" = credit_row."org_id"
          AND disable_event."team_id" IS NOT DISTINCT FROM credit_row."team_id"
          AND disable_event."service_id" = NEW."service_id"
          AND disable_event."app_key_id" = NEW."app_key_id"
          AND disable_event."previous_generation" + 1 = credit_row."auto_top_up_generation"
          AND disable_event."previous_consent_revision_id" = NEW."consent_revision_id"
      );
  END IF;

  IF credit_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR (credit_row."auto_top_up_consent_revision_id" IS DISTINCT FROM NEW."consent_revision_id"
       AND NOT authorized_disabled_attempt_update)
     OR (credit_row."auto_top_up_policy_id" IS DISTINCT FROM policy_row."id"
       AND NOT authorized_disabled_attempt_update)
     OR revision_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
     OR revision_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR revision_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR revision_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
     OR revision_row."policy_id" IS DISTINCT FROM policy_row."id"
     OR revision_row."option_id" IS DISTINCT FROM NEW."option_id"
     OR revision_row."refill_offer_id" IS DISTINCT FROM NEW."offer_id"
     OR revision_row."consented_by_user_id" IS DISTINCT FROM NEW."attributed_user_id"
     OR revision_row."consent_version" IS DISTINCT FROM NEW."consent_version"
     OR revision_row."threshold_microcredits" IS DISTINCT FROM NEW."threshold_microcredits"
     OR revision_row."monthly_charge_cap_minor" IS DISTINCT FROM NEW."monthly_charge_cap_minor"
     OR revision_row."refill_payment_amount_minor" IS DISTINCT FROM NEW."payment_amount_minor"
     OR revision_row."refill_credits_microcredits" IS DISTINCT FROM NEW."credits_received_microcredits"
     OR option_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR policy_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR policy_row."currency" IS DISTINCT FROM 'USD'
     OR NOT policy_row."automatic_top_up_enabled"
     OR policy_row."automatic_consent_version" IS DISTINCT FROM NEW."consent_version"
     OR option_row."refill_offer_id" IS DISTINCT FROM NEW."offer_id"
     OR offer_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR NOT offer_row."automatic_top_up_eligible"
     OR catalog_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR catalog_row."key" IS DISTINCT FROM offer_row."catalog_key"
     OR catalog_row."version" IS DISTINCT FROM offer_row."catalog_version"
     OR catalog_row."payment_amount_minor" IS DISTINCT FROM NEW."payment_amount_minor"
     OR catalog_row."payment_amount_minor" IS DISTINCT FROM offer_row."payment_amount_minor"
     OR catalog_row."credits_received_microcredits" IS DISTINCT FROM NEW."credits_received_microcredits"
     OR catalog_row."credits_received_microcredits" IS DISTINCT FROM offer_row."credits_received_microcredits"
     OR (
       TG_OP = 'INSERT'
       AND (
         credit_row."auto_top_up_state" IS DISTINCT FROM 'ACTIVE'
         OR credit_row."auto_top_up_service_id" IS DISTINCT FROM NEW."service_id"
         OR credit_row."auto_top_up_app_key_id" IS DISTINCT FROM NEW."app_key_id"
         OR credit_row."auto_top_up_consented_by_user_id" IS DISTINCT FROM NEW."attributed_user_id"
         OR credit_row."auto_top_up_option_id" IS DISTINCT FROM NEW."option_id"
         OR credit_row."auto_top_up_refill_offer_id" IS DISTINCT FROM NEW."offer_id"
         OR credit_row."auto_top_up_consent_version" IS DISTINCT FROM NEW."consent_version"
         OR credit_row."auto_top_up_threshold_microcredits" IS DISTINCT FROM NEW."threshold_microcredits"
         OR credit_row."auto_top_up_monthly_charge_cap_minor" IS DISTINCT FROM NEW."monthly_charge_cap_minor"
         OR credit_row."stripe_payment_method_id" IS NULL
         OR NOT policy_row."active"
         OR NOT option_row."active"
         OR NOT offer_row."active"
         OR catalog_row."stripe_price_id" IS NULL
       )
     ) THEN
    RAISE EXCEPTION 'automatic credit top-up attempt is not the consented team configuration'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND (
    NEW."observed_balance_microcredits" IS DISTINCT FROM credit_row."balance_microcredits"
    OR NEW."observed_balance_microcredits" >= NEW."threshold_microcredits"
  ) THEN
    RAISE EXCEPTION 'automatic top-up requires the locked balance to be below threshold'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(SUM(attempt."payment_amount_minor"), 0)
      INTO charged_before_minor
    FROM "billing_credit_auto_top_up_attempts" AS attempt
    WHERE attempt."credit_account_id" = NEW."credit_account_id"
      AND attempt."billing_month" = NEW."billing_month"
      AND attempt."status" = 'SUCCEEDED';
    IF NEW."charged_this_month_before_minor" IS DISTINCT FROM charged_before_minor
       OR charged_before_minor + NEW."payment_amount_minor"
         > NEW."monthly_charge_cap_minor" THEN
      RAISE EXCEPTION 'automatic top-up monthly charge snapshot or cap is stale'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" IN ('SUCCEEDED', 'FAILED', 'CANCELED') THEN
    IF ROW(
      NEW."stripe_payment_intent_id", NEW."success_webhook_event_id", NEW."status",
      NEW."failure_code", NEW."credit_entry_id", NEW."resolved_at"
    ) IS DISTINCT FROM ROW(
      OLD."stripe_payment_intent_id", OLD."success_webhook_event_id", OLD."status",
      OLD."failure_code", OLD."credit_entry_id", OLD."resolved_at"
    ) THEN
      RAISE EXCEPTION 'terminal automatic top-up attempt proof is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."trigger_entry_id" IS NOT NULL THEN
    SELECT * INTO trigger_row FROM "billing_credit_entries"
      WHERE "id" = NEW."trigger_entry_id";
    PERFORM "billing_assert_credit_app_key_service"(
      trigger_row."service_id", trigger_row."app_key_id"
    );
    IF trigger_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
       OR trigger_row."kind" NOT IN ('USAGE_SETTLEMENT', 'USAGE_SETTLEMENT_CORRECTION')
       OR trigger_row."direction" IS DISTINCT FROM 'DEBIT' THEN
      RAISE EXCEPTION 'automatic top-up trigger entry is not exact aggregate usage'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."status" = 'SUCCEEDED' THEN
    SELECT * INTO success_event_row FROM "billing_stripe_webhook_events"
      WHERE "id" = NEW."success_webhook_event_id";
    SELECT * INTO entry_row FROM "billing_credit_entries"
      WHERE "id" = NEW."credit_entry_id";
    IF success_event_row."id" IS NULL
       OR success_event_row."type" IS DISTINCT FROM 'payment_intent.succeeded'
       OR success_event_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR success_event_row."livemode" IS DISTINCT FROM account_livemode
       OR success_event_row."stripe_object_id" IS DISTINCT FROM NEW."stripe_payment_intent_id"
       OR success_event_row."stripe_payment_intent_id" IS DISTINCT FROM NEW."stripe_payment_intent_id"
       OR success_event_row."stripe_customer_id" IS DISTINCT FROM customer_row."stripe_customer_id"
       OR success_event_row."stripe_payment_method_id" IS DISTINCT FROM revision_row."stripe_payment_method_id"
       OR success_event_row."amount_minor" IS DISTINCT FROM NEW."payment_amount_minor"
       OR success_event_row."currency" IS DISTINCT FROM 'USD'
       OR success_event_row."stripe_created_at" IS DISTINCT FROM NEW."resolved_at"
       OR entry_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
       OR entry_row."service_id" IS DISTINCT FROM NEW."service_id"
       OR entry_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
       OR entry_row."attributed_user_id" IS DISTINCT FROM NEW."attributed_user_id"
       OR entry_row."kind" IS DISTINCT FROM 'AUTOMATIC_TOP_UP'
       OR entry_row."direction" IS DISTINCT FROM 'CREDIT'
       OR entry_row."amount_microcredits" IS DISTINCT FROM NEW."credits_received_microcredits"
       OR entry_row."source_type" IS DISTINCT FROM 'credit_auto_top_up_attempt'
       OR entry_row."source_id" IS DISTINCT FROM NEW."id" THEN
      RAISE EXCEPTION 'successful automatic top-up does not match its immutable entry'
      USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NEW."status" = 'REQUIRES_ACTION' THEN
      UPDATE "billing_credit_accounts"
      SET "auto_top_up_state" = 'REQUIRES_ACTION', "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = NEW."credit_account_id"
        AND "auto_top_up_consent_revision_id" = NEW."consent_revision_id"
        AND "auto_top_up_state" <> 'DISABLED';
    ELSIF NEW."status" IN ('NEEDS_REVIEW', 'FAILED', 'CANCELED') THEN
      UPDATE "billing_credit_accounts"
      SET "auto_top_up_state" = 'NEEDS_REVIEW', "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = NEW."credit_account_id"
        AND "auto_top_up_consent_revision_id" = NEW."consent_revision_id"
        AND "auto_top_up_state" <> 'DISABLED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
