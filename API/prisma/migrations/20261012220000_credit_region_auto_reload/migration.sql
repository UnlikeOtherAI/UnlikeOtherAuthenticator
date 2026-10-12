SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- Automatic reload in the region currency. A USD option keeps its threshold in
-- credits; a GBP or EUR option sets it in its currency (threshold_amount_minor,
-- with threshold_microcredits 0) and is compared with the lots' value in that
-- currency. A GBP or EUR reload reads the live rate when its attempt is created,
-- just before the off-session PaymentIntent, and keeps the rate as evidence.
ALTER TABLE billing_credit_auto_top_up_options ADD COLUMN threshold_amount_minor BIGINT,
  ADD CONSTRAINT billing_credit_auto_top_up_options_amount_threshold CHECK (
    threshold_amount_minor IS NULL OR threshold_amount_minor > 0);
ALTER TABLE billing_credit_setup_checkouts ADD COLUMN threshold_amount_minor BIGINT,
  DROP CONSTRAINT billing_credit_setup_checkouts_values_check,
  ADD CONSTRAINT billing_credit_setup_checkouts_values_check CHECK (
    threshold_microcredits >= 0 AND refill_payment_amount_minor > 0
    AND (threshold_amount_minor IS NULL OR threshold_amount_minor > 0)
    AND (refill_credits_microcredits::numeric = refill_payment_amount_minor::numeric * 10000000
      OR (refill_credits_microcredits = 0 AND threshold_amount_minor IS NOT NULL))
    AND monthly_charge_cap_minor >= refill_payment_amount_minor);
ALTER TABLE billing_credit_auto_top_up_consent_revisions ADD COLUMN threshold_amount_minor BIGINT,
  DROP CONSTRAINT billing_credit_consent_revisions_values_check,
  ADD CONSTRAINT billing_credit_consent_revisions_values_check CHECK (
    length(btrim(actor_jti)) > 0 AND length(btrim(consent_version)) > 0
    AND length(btrim(stripe_payment_method_id)) > 0
    AND threshold_microcredits >= 0 AND threshold_microcredits % 10 = 0
    AND refill_payment_amount_minor > 0
    AND (threshold_amount_minor IS NULL OR threshold_amount_minor > 0)
    AND (refill_credits_microcredits::numeric = refill_payment_amount_minor::numeric * 10000000
      OR (refill_credits_microcredits = 0 AND threshold_amount_minor IS NOT NULL))
    AND monthly_charge_cap_minor >= refill_payment_amount_minor);

ALTER TABLE billing_credit_auto_top_up_attempts
  DROP CONSTRAINT billing_credit_auto_top_up_attempt_usd_only,
  ADD CONSTRAINT billing_credit_auto_top_up_attempt_currency CHECK (currency IN ('USD', 'EUR', 'GBP')),
  ADD COLUMN threshold_amount_minor BIGINT,
  ADD COLUMN observed_value_minor BIGINT,
  ADD COLUMN fx_rate_source VARCHAR(10),
  ADD COLUMN fx_base_rate DECIMAL(38,18),
  ADD COLUMN fx_exchange_rate DECIMAL(38,18),
  ADD COLUMN fx_quote_id VARCHAR(255),
  ADD COLUMN fx_snapshot_id TEXT,
  ADD CONSTRAINT billing_credit_auto_top_up_attempts_fx_snapshot FOREIGN KEY (fx_snapshot_id)
    REFERENCES billing_sms_fx_snapshots(id) ON DELETE RESTRICT,
  DROP CONSTRAINT billing_credit_auto_top_up_attempts_values_check,
  -- COALESCE: a comparison with a missing rate is unknown, and a CHECK passes unknown.
  ADD CONSTRAINT billing_credit_auto_top_up_attempts_values_check CHECK (COALESCE(
    threshold_microcredits >= 0 AND monthly_charge_cap_minor > 0 AND charged_this_month_before_minor >= 0
    AND payment_amount_minor > 0
    AND charged_this_month_before_minor + payment_amount_minor <= monthly_charge_cap_minor
    AND (
      (currency = 'USD' AND credits_received_microcredits::numeric = payment_amount_minor::numeric * 10000000
        AND threshold_amount_minor IS NULL AND observed_value_minor IS NULL
        AND fx_rate_source IS NULL AND fx_base_rate IS NULL AND fx_exchange_rate IS NULL
        AND fx_quote_id IS NULL AND fx_snapshot_id IS NULL)
      OR (currency IN ('EUR', 'GBP') AND threshold_microcredits = 0 AND threshold_amount_minor > 0
        AND observed_value_minor IS NOT NULL
        AND credits_received_microcredits > 0 AND credits_received_microcredits % 1000000 = 0
        AND fx_base_rate > 0
        AND ((fx_rate_source = 'stripe' AND fx_quote_id ~ '^fxq_[A-Za-z0-9_]+$'
            AND fx_exchange_rate > 0 AND fx_snapshot_id IS NULL)
          OR (fx_rate_source = 'ecb' AND fx_snapshot_id IS NOT NULL AND fx_quote_id IS NULL
            AND fx_exchange_rate IS NULL)))), false));

CREATE OR REPLACE FUNCTION "billing_credit_auto_option_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  policy_row "billing_credit_funding_policies"%ROWTYPE;
  offer_row "billing_credit_top_up_offers"%ROWTYPE;
BEGIN
  SELECT * INTO policy_row
  FROM "billing_credit_funding_policies"
  WHERE "id" = NEW."policy_id";
  SELECT * INTO offer_row
  FROM "billing_credit_top_up_offers"
  WHERE "id" = NEW."refill_offer_id";
  IF policy_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR policy_row."currency" NOT IN ('USD', 'EUR', 'GBP')
     -- A USD option sets its threshold in credits; a GBP or EUR one in its currency.
     OR (policy_row."currency" = 'USD') <> (NEW."threshold_amount_minor" IS NULL)
     OR (policy_row."currency" <> 'USD' AND NEW."threshold_microcredits" <> 0)
     OR offer_row."policy_id" IS DISTINCT FROM NEW."policy_id"
     OR offer_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR NOT offer_row."automatic_top_up_eligible"
     OR NEW."monthly_charge_cap_minor" < offer_row."payment_amount_minor" THEN
    RAISE EXCEPTION 'automatic top-up option does not match its policy and refill offer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "billing_credit_consent_revision_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_row "billing_credit_accounts"%ROWTYPE;
  policy_row "billing_credit_funding_policies"%ROWTYPE;
  revision_row "billing_credit_auto_top_up_consent_revisions"%ROWTYPE;
  option_row "billing_credit_auto_top_up_options"%ROWTYPE;
  offer_row "billing_credit_top_up_offers"%ROWTYPE;
  checkout_row "billing_credit_setup_checkouts"%ROWTYPE;
BEGIN
  SELECT * INTO credit_row FROM "billing_credit_accounts"
    WHERE "id" = NEW."credit_account_id" FOR UPDATE;
  SELECT * INTO policy_row FROM "billing_credit_funding_policies"
    WHERE "id" = NEW."policy_id";
  SELECT * INTO option_row FROM "billing_credit_auto_top_up_options"
    WHERE "id" = NEW."option_id";
  SELECT * INTO offer_row FROM "billing_credit_top_up_offers"
    WHERE "id" = NEW."refill_offer_id";
  PERFORM "billing_assert_credit_app_key"(NEW."service_id", NEW."app_key_id");
  PERFORM "billing_assert_credit_scope_manager"(
    NEW."org_id", NEW."team_id", NEW."consented_by_user_id"
  );
  IF credit_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR credit_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR credit_row."team_id" IS DISTINCT FROM NEW."team_id"
     OR policy_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR policy_row."currency" NOT IN ('USD', 'EUR', 'GBP')
     OR NOT policy_row."active"
     OR NOT policy_row."automatic_top_up_enabled"
     OR policy_row."automatic_consent_version" IS DISTINCT FROM NEW."consent_version"
     OR option_row."policy_id" IS DISTINCT FROM NEW."policy_id"
     OR option_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR option_row."refill_offer_id" IS DISTINCT FROM NEW."refill_offer_id"
     OR option_row."threshold_microcredits" IS DISTINCT FROM NEW."threshold_microcredits"
     OR option_row."threshold_amount_minor" IS DISTINCT FROM NEW."threshold_amount_minor"
     OR option_row."monthly_charge_cap_minor" IS DISTINCT FROM NEW."monthly_charge_cap_minor"
     OR NOT option_row."active"
     OR offer_row."policy_id" IS DISTINCT FROM NEW."policy_id"
     OR offer_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR offer_row."credits_received_microcredits" IS DISTINCT FROM NEW."refill_credits_microcredits"
     OR offer_row."payment_amount_minor" IS DISTINCT FROM NEW."refill_payment_amount_minor"
     OR NOT offer_row."active"
     OR NOT offer_row."automatic_top_up_eligible" THEN
    RAISE EXCEPTION 'automatic top-up consent revision does not match active exact terms'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."source" = 'SETUP_CHECKOUT' THEN
    SELECT * INTO checkout_row FROM "billing_credit_setup_checkouts"
      WHERE "id" = NEW."setup_checkout_id";
    IF checkout_row."status" IS DISTINCT FROM 'COMPLETE'
       OR checkout_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR checkout_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
       OR checkout_row."service_id" IS DISTINCT FROM NEW."service_id"
       OR checkout_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
       OR checkout_row."policy_id" IS DISTINCT FROM NEW."policy_id"
       OR checkout_row."option_id" IS DISTINCT FROM NEW."option_id"
       OR checkout_row."refill_offer_id" IS DISTINCT FROM NEW."refill_offer_id"
       OR checkout_row."actor_jti" IS DISTINCT FROM NEW."actor_jti"
       OR checkout_row."requested_by_user_id" IS DISTINCT FROM NEW."consented_by_user_id"
       OR checkout_row."consent_version" IS DISTINCT FROM NEW."consent_version"
       OR checkout_row."threshold_microcredits" IS DISTINCT FROM NEW."threshold_microcredits"
       OR checkout_row."threshold_amount_minor" IS DISTINCT FROM NEW."threshold_amount_minor"
       OR checkout_row."refill_credits_microcredits" IS DISTINCT FROM NEW."refill_credits_microcredits"
       OR checkout_row."refill_payment_amount_minor" IS DISTINCT FROM NEW."refill_payment_amount_minor"
       OR checkout_row."monthly_charge_cap_minor" IS DISTINCT FROM NEW."monthly_charge_cap_minor"
       OR checkout_row."stripe_payment_method_id" IS DISTINCT FROM NEW."stripe_payment_method_id" THEN
      RAISE EXCEPTION 'setup consent revision requires exact completed Checkout evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSIF credit_row."auto_top_up_consent_revision_id" IS NULL
     OR credit_row."stripe_payment_method_id" IS NULL
     OR credit_row."stripe_payment_method_id" IS DISTINCT FROM NEW."stripe_payment_method_id" THEN
    RAISE EXCEPTION 'customer option update must reuse the current Setup-verified payment method'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "billing_credit_setup_checkout_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_row "billing_credit_accounts"%ROWTYPE;
  customer_row "billing_stripe_customers"%ROWTYPE;
  policy_row "billing_credit_funding_policies"%ROWTYPE;
  option_row "billing_credit_auto_top_up_options"%ROWTYPE;
  offer_row "billing_credit_top_up_offers"%ROWTYPE;
  completion_event_row "billing_stripe_webhook_events"%ROWTYPE;
  account_livemode BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' AND (
    NEW."status" IS DISTINCT FROM 'CREATING'
    OR NEW."stripe_checkout_session_id" IS NOT NULL
    OR NEW."stripe_setup_intent_id" IS NOT NULL
    OR NEW."stripe_payment_method_id" IS NOT NULL
    OR NEW."completion_webhook_event_id" IS NOT NULL
    OR NEW."completed_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'new automatic top-up setup must begin creating without proof'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'COMPLETE' THEN
    IF ROW(
      NEW."status", NEW."stripe_checkout_session_id", NEW."stripe_setup_intent_id",
      NEW."stripe_payment_method_id", NEW."completion_webhook_event_id", NEW."completed_at"
    ) IS DISTINCT FROM ROW(
      OLD."status", OLD."stripe_checkout_session_id", OLD."stripe_setup_intent_id",
      OLD."stripe_payment_method_id", OLD."completion_webhook_event_id", OLD."completed_at"
    ) THEN
      RAISE EXCEPTION 'completed automatic top-up setup proof is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO credit_row FROM "billing_credit_accounts"
    WHERE "id" = NEW."credit_account_id";
  SELECT * INTO customer_row FROM "billing_stripe_customers"
    WHERE "id" = NEW."customer_id";
  SELECT * INTO policy_row FROM "billing_credit_funding_policies"
    WHERE "id" = NEW."policy_id";
  SELECT * INTO option_row FROM "billing_credit_auto_top_up_options"
    WHERE "id" = NEW."option_id";
  SELECT * INTO offer_row FROM "billing_credit_top_up_offers"
    WHERE "id" = NEW."refill_offer_id";
  SELECT "livemode" INTO account_livemode FROM "billing_stripe_accounts"
    WHERE "id" = NEW."account_id";
  PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");
  IF TG_OP = 'INSERT' THEN
    PERFORM "billing_assert_credit_app_key"(NEW."service_id", NEW."app_key_id");
    PERFORM "billing_assert_credit_scope_manager"(
      credit_row."org_id", credit_row."team_id", NEW."requested_by_user_id"
    );
  END IF;

  IF length(btrim(NEW."actor_jti")) = 0
     OR credit_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR credit_row."customer_id" IS DISTINCT FROM NEW."customer_id"
     OR customer_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR customer_row."team_id" IS DISTINCT FROM credit_row."team_id"
     OR policy_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR policy_row."currency" NOT IN ('USD', 'EUR', 'GBP')
     OR NOT policy_row."automatic_top_up_enabled"
     OR policy_row."automatic_consent_version" IS DISTINCT FROM NEW."consent_version"
     OR option_row."policy_id" IS DISTINCT FROM NEW."policy_id"
     OR option_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR option_row."refill_offer_id" IS DISTINCT FROM NEW."refill_offer_id"
     OR option_row."threshold_microcredits" IS DISTINCT FROM NEW."threshold_microcredits"
     OR option_row."threshold_amount_minor" IS DISTINCT FROM NEW."threshold_amount_minor"
     OR option_row."monthly_charge_cap_minor" IS DISTINCT FROM NEW."monthly_charge_cap_minor"
     OR offer_row."policy_id" IS DISTINCT FROM NEW."policy_id"
     OR offer_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR offer_row."credits_received_microcredits" IS DISTINCT FROM NEW."refill_credits_microcredits"
     OR offer_row."payment_amount_minor" IS DISTINCT FROM NEW."refill_payment_amount_minor"
     OR NOT offer_row."automatic_top_up_eligible"
     OR NOT EXISTS (
       SELECT 1 FROM "billing_credit_top_up_catalogs" AS catalog
       WHERE catalog."account_id" = NEW."account_id"
         AND catalog."key" = offer_row."catalog_key"
         AND catalog."version" = offer_row."catalog_version"
         AND catalog."payment_amount_minor" = offer_row."payment_amount_minor"
         AND catalog."credits_received_microcredits" = offer_row."credits_received_microcredits"
     )
     OR (
       TG_OP = 'INSERT'
       AND (
         NOT policy_row."active"
         OR NOT option_row."active"
         OR NOT offer_row."active"
         OR NOT EXISTS (
           SELECT 1 FROM "billing_credit_top_up_catalogs" AS catalog
           WHERE catalog."account_id" = NEW."account_id"
             AND catalog."key" = offer_row."catalog_key"
             AND catalog."version" = offer_row."catalog_version"
             AND catalog."stripe_price_id" IS NOT NULL
         )
       )
     ) THEN
    RAISE EXCEPTION 'automatic top-up setup binding is incoherent'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'COMPLETE' THEN
    SELECT * INTO completion_event_row FROM "billing_stripe_webhook_events"
      WHERE "id" = NEW."completion_webhook_event_id";
    IF completion_event_row."id" IS NULL
       OR completion_event_row."type" IS DISTINCT FROM 'setup_intent.succeeded'
       OR completion_event_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR completion_event_row."livemode" IS DISTINCT FROM account_livemode
       OR completion_event_row."stripe_object_id" IS DISTINCT FROM NEW."stripe_setup_intent_id"
       OR completion_event_row."stripe_checkout_session_id" IS DISTINCT FROM NEW."stripe_checkout_session_id"
       OR completion_event_row."stripe_setup_intent_id" IS DISTINCT FROM NEW."stripe_setup_intent_id"
       OR completion_event_row."stripe_payment_method_id" IS DISTINCT FROM NEW."stripe_payment_method_id"
       OR completion_event_row."stripe_customer_id" IS DISTINCT FROM customer_row."stripe_customer_id"
       OR completion_event_row."stripe_created_at" IS DISTINCT FROM NEW."completed_at" THEN
      RAISE EXCEPTION 'completed automatic top-up setup lacks exact Stripe evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "billing_credit_account_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  team_org_id TEXT;
  customer_row "billing_stripe_customers"%ROWTYPE;
  policy_row "billing_credit_funding_policies"%ROWTYPE;
  option_row "billing_credit_auto_top_up_options"%ROWTYPE;
  offer_row "billing_credit_top_up_offers"%ROWTYPE;
  revision_row "billing_credit_auto_top_up_consent_revisions"%ROWTYPE;
  consent_changed BOOLEAN;
BEGIN
  consent_changed := TG_OP = 'INSERT';
  IF TG_OP = 'INSERT' AND NEW."balance_microcredits" <> 0 THEN
    RAISE EXCEPTION 'new credit accounts must start at zero balance'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    consent_changed := ROW(
      NEW."auto_top_up_policy_id",
      NEW."auto_top_up_service_id", NEW."auto_top_up_app_key_id",
      NEW."auto_top_up_consent_revision_id",
      NEW."auto_top_up_option_id", NEW."auto_top_up_threshold_microcredits",
      NEW."auto_top_up_refill_offer_id", NEW."auto_top_up_monthly_charge_cap_minor",
      NEW."auto_top_up_consent_version", NEW."auto_top_up_consented_at",
      NEW."auto_top_up_consented_by_user_id", NEW."stripe_payment_method_id",
      NEW."payment_method_summary"
    ) IS DISTINCT FROM ROW(
      OLD."auto_top_up_policy_id",
      OLD."auto_top_up_service_id", OLD."auto_top_up_app_key_id",
      OLD."auto_top_up_consent_revision_id",
      OLD."auto_top_up_option_id", OLD."auto_top_up_threshold_microcredits",
      OLD."auto_top_up_refill_offer_id", OLD."auto_top_up_monthly_charge_cap_minor",
      OLD."auto_top_up_consent_version", OLD."auto_top_up_consented_at",
      OLD."auto_top_up_consented_by_user_id", OLD."stripe_payment_method_id",
      OLD."payment_method_summary"
    );
    IF OLD."auto_top_up_state" IN ('PAUSED', 'REQUIRES_ACTION', 'NEEDS_REVIEW')
       AND NEW."auto_top_up_state" = 'ACTIVE'
       AND NOT consent_changed THEN
      RAISE EXCEPTION 'automatic top-up recovery requires a new verified consent revision'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."scope" = 'TEAM' THEN
    IF NEW."team_id" IS NULL
       OR NEW."scope_key" IS DISTINCT FROM NEW."org_id" || ':' || NEW."team_id" THEN
      RAISE EXCEPTION 'team-scoped credit account requires its exact team scope key'
        USING ERRCODE = '23514';
    END IF;
    SELECT "org_id" INTO team_org_id FROM "teams" WHERE "id" = NEW."team_id";
  ELSE
    IF NEW."team_id" IS NOT NULL OR NEW."scope_key" IS DISTINCT FROM NEW."org_id" THEN
      RAISE EXCEPTION 'organisation-scoped credit account carries no team and the organisation scope key'
        USING ERRCODE = '23514';
    END IF;
    team_org_id := NEW."org_id";
  END IF;
  SELECT * INTO customer_row FROM "billing_stripe_customers" WHERE "id" = NEW."customer_id";
  IF team_org_id IS DISTINCT FROM NEW."org_id"
     OR customer_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR customer_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR customer_row."team_id" IS DISTINCT FROM NEW."team_id"
     OR customer_row."scope" IS DISTINCT FROM NEW."scope"
     OR customer_row."scope_key" IS DISTINCT FROM NEW."scope_key" THEN
    RAISE EXCEPTION 'credit account must bind one exact same-scope Stripe customer'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."auto_top_up_policy_id" IS NOT NULL THEN
    SELECT * INTO policy_row
    FROM "billing_credit_funding_policies" WHERE "id" = NEW."auto_top_up_policy_id";
    SELECT * INTO option_row
    FROM "billing_credit_auto_top_up_options" WHERE "id" = NEW."auto_top_up_option_id";
    SELECT * INTO offer_row
    FROM "billing_credit_top_up_offers" WHERE "id" = NEW."auto_top_up_refill_offer_id";
    SELECT * INTO revision_row
    FROM "billing_credit_auto_top_up_consent_revisions"
    WHERE "id" = NEW."auto_top_up_consent_revision_id";
    PERFORM "billing_assert_credit_app_key_service"(
      NEW."auto_top_up_service_id", NEW."auto_top_up_app_key_id"
    );
    IF consent_changed AND NEW."auto_top_up_state" <> 'DISABLED' THEN
      PERFORM "billing_assert_credit_app_key"(
        NEW."auto_top_up_service_id", NEW."auto_top_up_app_key_id"
      );
      PERFORM "billing_assert_credit_scope_manager"(
        NEW."org_id", NEW."team_id", NEW."auto_top_up_consented_by_user_id"
      );
    END IF;
    IF policy_row."service_id" IS DISTINCT FROM NEW."auto_top_up_service_id"
       OR revision_row."credit_account_id" IS DISTINCT FROM NEW."id"
       OR revision_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR revision_row."org_id" IS DISTINCT FROM NEW."org_id"
       OR revision_row."team_id" IS DISTINCT FROM NEW."team_id"
       OR revision_row."service_id" IS DISTINCT FROM NEW."auto_top_up_service_id"
       OR revision_row."app_key_id" IS DISTINCT FROM NEW."auto_top_up_app_key_id"
       OR revision_row."policy_id" IS DISTINCT FROM NEW."auto_top_up_policy_id"
       OR revision_row."option_id" IS DISTINCT FROM NEW."auto_top_up_option_id"
       OR revision_row."refill_offer_id" IS DISTINCT FROM NEW."auto_top_up_refill_offer_id"
       OR revision_row."consent_version" IS DISTINCT FROM NEW."auto_top_up_consent_version"
       OR revision_row."threshold_microcredits" IS DISTINCT FROM NEW."auto_top_up_threshold_microcredits"
       OR revision_row."monthly_charge_cap_minor" IS DISTINCT FROM NEW."auto_top_up_monthly_charge_cap_minor"
       OR revision_row."consented_at" IS DISTINCT FROM NEW."auto_top_up_consented_at"
       OR revision_row."consented_by_user_id" IS DISTINCT FROM NEW."auto_top_up_consented_by_user_id"
       OR revision_row."stripe_payment_method_id" IS DISTINCT FROM NEW."stripe_payment_method_id"
       OR revision_row."payment_method_summary" IS DISTINCT FROM NEW."payment_method_summary"
       OR policy_row."currency" NOT IN ('USD', 'EUR', 'GBP')
       OR NOT policy_row."automatic_top_up_enabled"
       OR policy_row."automatic_consent_version" IS DISTINCT FROM NEW."auto_top_up_consent_version"
       OR option_row."policy_id" IS DISTINCT FROM policy_row."id"
       OR option_row."service_id" IS DISTINCT FROM NEW."auto_top_up_service_id"
       OR option_row."refill_offer_id" IS DISTINCT FROM offer_row."id"
       OR offer_row."policy_id" IS DISTINCT FROM policy_row."id"
       OR offer_row."service_id" IS DISTINCT FROM NEW."auto_top_up_service_id"
       OR NOT offer_row."automatic_top_up_eligible"
       OR option_row."threshold_microcredits" IS DISTINCT FROM NEW."auto_top_up_threshold_microcredits"
       OR option_row."monthly_charge_cap_minor" IS DISTINCT FROM NEW."auto_top_up_monthly_charge_cap_minor"
       OR (
         consent_changed AND NEW."auto_top_up_state" <> 'DISABLED'
         AND (NOT policy_row."active" OR NOT option_row."active" OR NOT offer_row."active")
       ) THEN
      RAISE EXCEPTION 'credit account automatic top-up snapshot is incoherent'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

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
     -- A USD reload's credits are its offer's; a GBP or EUR one's follow the rate it was read at.
     OR (NEW."currency" = 'USD'
       AND revision_row."refill_credits_microcredits" IS DISTINCT FROM NEW."credits_received_microcredits")
     OR revision_row."threshold_amount_minor" IS DISTINCT FROM NEW."threshold_amount_minor"
     OR option_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR policy_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR policy_row."currency" IS DISTINCT FROM NEW."currency"
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
     OR catalog_row."currency" IS DISTINCT FROM NEW."currency"
     OR (NEW."currency" = 'USD'
       AND catalog_row."credits_received_microcredits" IS DISTINCT FROM NEW."credits_received_microcredits")
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
    OR (NEW."currency" = 'USD' AND NEW."observed_balance_microcredits" >= NEW."threshold_microcredits")
    -- A GBP or EUR threshold is a value: the lots' worth in that currency, observed under the same lock.
    OR (NEW."currency" <> 'USD' AND (NEW."observed_value_minor" IS NULL
      OR NEW."observed_value_minor" >= NEW."threshold_amount_minor"))
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
       OR success_event_row."currency" IS DISTINCT FROM NEW."currency"
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

CREATE OR REPLACE FUNCTION "billing_credit_auto_top_up_state_evidence"() RETURNS trigger
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
       OR webhook_row."currency" IS DISTINCT FROM NEW."currency"
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

CREATE OR REPLACE FUNCTION billing_credit_lots_apply_entry(entry billing_credit_entries) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  account TEXT := entry.credit_account_id;
  left_over BIGINT := entry.amount_microcredits;
  take BIGINT;
  debt BIGINT;
  lot billing_credit_lots%ROWTYPE;
  lot_currency CHAR(3);
  lot_paid BIGINT;
  lot_rate NUMERIC;
  new_lot TEXT;
  lots_total NUMERIC;
  account_balance BIGINT;
BEGIN
  PERFORM billing_credit_lots_backfill(account, entry);
  IF entry.direction = 'CREDIT' AND entry.kind IN ('TOP_UP', 'AUTOMATIC_TOP_UP', 'ADJUSTMENT') THEN
    IF entry.kind = 'TOP_UP' THEN
      SELECT checkout.currency, checkout.payment_amount_minor, COALESCE(checkout.fx_base_rate, 1)
        INTO lot_currency, lot_paid, lot_rate
        FROM billing_credit_top_up_checkouts AS checkout WHERE checkout.id = entry.source_id;
    ELSIF entry.kind = 'AUTOMATIC_TOP_UP' THEN
      SELECT attempt.currency, attempt.payment_amount_minor, COALESCE(attempt.fx_base_rate, 1)
        INTO lot_currency, lot_paid, lot_rate
        FROM billing_credit_auto_top_up_attempts AS attempt WHERE attempt.id = entry.source_id;
    ELSE
      lot_currency := 'USD'; lot_paid := 0; lot_rate := 1;
    END IF;
    IF lot_currency IS NULL THEN
      RAISE EXCEPTION 'a credit grant needs its purchase evidence to open a lot' USING ERRCODE = '23514';
    END IF;
    new_lot := 'bcl_' || entry.id;
    INSERT INTO billing_credit_lots (id, credit_account_id, source_entry_id, sequence, currency,
      paid_amount_minor, usd_per_unit, granted_microcredits, remaining_microcredits, opened_at)
    SELECT new_lot, account, entry.id, COALESCE(MAX(existing.sequence), 0) + 1, lot_currency, lot_paid,
      lot_rate, entry.amount_microcredits, entry.amount_microcredits, entry.occurred_at
    FROM billing_credit_lots AS existing WHERE existing.credit_account_id = account;
    -- A grant first pays down debt a verified payment reversal left behind.
    debt := billing_credit_lot_debt(account);
    IF debt > 0 THEN
      take := LEAST(debt, entry.amount_microcredits);
      PERFORM billing_credit_lot_move(new_lot, account, entry.id, -take);
      PERFORM billing_credit_lot_move(NULL, account, entry.id, take);
    END IF;
  ELSIF entry.direction = 'CREDIT' THEN
    -- A usage correction or payment reversal gives credits back: first to any debt,
    -- then to the reversed payment's own lot, then to the newest lot that gave any.
    debt := billing_credit_lot_debt(account);
    IF debt > 0 THEN
      take := LEAST(debt, left_over);
      PERFORM billing_credit_lot_move(NULL, account, entry.id, take);
      left_over := left_over - take;
    END IF;
    IF left_over > 0 AND entry.reverses_entry_id IS NOT NULL THEN
      SELECT * INTO lot FROM billing_credit_lots WHERE source_entry_id = entry.reverses_entry_id FOR UPDATE;
      IF lot.id IS NOT NULL THEN
        take := LEAST(lot.granted_microcredits - lot.remaining_microcredits, left_over);
        PERFORM billing_credit_lot_move(lot.id, account, entry.id, take);
        left_over := left_over - take;
      END IF;
    END IF;
    FOR lot IN SELECT * FROM billing_credit_lots
        WHERE credit_account_id = account AND remaining_microcredits < granted_microcredits
        ORDER BY sequence DESC FOR UPDATE LOOP
      EXIT WHEN left_over = 0;
      take := LEAST(lot.granted_microcredits - lot.remaining_microcredits, left_over);
      PERFORM billing_credit_lot_move(lot.id, account, entry.id, take);
      left_over := left_over - take;
    END LOOP;
    IF left_over > 0 THEN
      RAISE EXCEPTION 'credits given back exceed what the lots have given' USING ERRCODE = '23514';
    END IF;
  ELSE
    -- A refund or dispute draws its own payment's lot first; every debit then draws oldest-first.
    IF entry.reverses_entry_id IS NOT NULL THEN
      SELECT * INTO lot FROM billing_credit_lots WHERE source_entry_id = entry.reverses_entry_id FOR UPDATE;
      IF lot.id IS NOT NULL THEN
        take := LEAST(lot.remaining_microcredits, left_over);
        PERFORM billing_credit_lot_move(lot.id, account, entry.id, -take);
        left_over := left_over - take;
      END IF;
    END IF;
    FOR lot IN SELECT * FROM billing_credit_lots
        WHERE credit_account_id = account AND remaining_microcredits > 0
        ORDER BY sequence ASC FOR UPDATE LOOP
      EXIT WHEN left_over = 0;
      take := LEAST(lot.remaining_microcredits, left_over);
      PERFORM billing_credit_lot_move(lot.id, account, entry.id, -take);
      left_over := left_over - take;
    END LOOP;
    -- Only a verified reversal can leave more debited than the lots hold.
    PERFORM billing_credit_lot_move(NULL, account, entry.id, -left_over);
  END IF;

  SELECT COALESCE(SUM(remaining_microcredits), 0) INTO lots_total
    FROM billing_credit_lots WHERE credit_account_id = account;
  SELECT balance_microcredits INTO account_balance FROM billing_credit_accounts WHERE id = account;
  IF lots_total - billing_credit_lot_debt(account) <> account_balance THEN
    RAISE EXCEPTION 'credit lots do not match the account balance' USING ERRCODE = '23514';
  END IF;
END $$;
