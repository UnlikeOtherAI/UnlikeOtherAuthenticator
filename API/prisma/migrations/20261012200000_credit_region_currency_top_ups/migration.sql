SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- Credits stay one USD-denominated unit. An organisation in the UK or Europe
-- buys them in GBP or EUR; the credits granted follow the live rate at checkout
-- and are stored on the checkout with the rate as evidence. Existing USD rows
-- are unchanged; credit accounts and ledger entries stay USD.
ALTER TABLE billing_credit_funding_policies
  DROP CONSTRAINT billing_credit_funding_policies_currency_check,
  ADD CONSTRAINT billing_credit_funding_policies_currency_check CHECK (currency IN ('USD', 'EUR', 'GBP'));
-- One active policy per service and purchase currency.
DROP INDEX billing_credit_funding_policies_one_active_version;
CREATE UNIQUE INDEX billing_credit_funding_policies_one_active_version
  ON billing_credit_funding_policies(service_id, currency) WHERE active;

-- A GBP or EUR offer and catalog carry no fixed credit count (0): it is decided at checkout.
ALTER TABLE billing_credit_top_up_catalogs
  DROP CONSTRAINT billing_credit_top_up_catalogs_currency_check,
  ADD CONSTRAINT billing_credit_top_up_catalogs_currency_check CHECK (currency IN ('USD', 'EUR', 'GBP')),
  DROP CONSTRAINT billing_credit_top_up_catalogs_fixed_conversion_check,
  ADD CONSTRAINT billing_credit_top_up_catalogs_fixed_conversion_check CHECK (
    payment_amount_minor > 0 AND (
      (currency = 'USD' AND credits_received_microcredits::numeric = payment_amount_minor::numeric * 10000000)
      OR (currency IN ('EUR', 'GBP') AND credits_received_microcredits = 0)));
ALTER TABLE billing_credit_top_up_offers
  DROP CONSTRAINT billing_credit_top_up_offers_fixed_conversion_check,
  ADD CONSTRAINT billing_credit_top_up_offers_fixed_conversion_check CHECK (
    payment_amount_minor > 0 AND (
      credits_received_microcredits::numeric = payment_amount_minor::numeric * 10000000
      OR credits_received_microcredits = 0));
-- An offer follows its policy's currency: a USD offer fixes its credits, a GBP or EUR one carries none.
CREATE OR REPLACE FUNCTION "billing_credit_offer_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  policy_row "billing_credit_funding_policies"%ROWTYPE;
BEGIN
  SELECT * INTO policy_row
  FROM "billing_credit_funding_policies"
  WHERE "id" = NEW."policy_id";
  IF NOT FOUND
     OR policy_row."service_id" <> NEW."service_id"
     OR policy_row."currency" NOT IN ('USD', 'EUR', 'GBP')
     OR (policy_row."currency" = 'USD') <> (NEW."credits_received_microcredits" > 0) THEN
    RAISE EXCEPTION 'credit offer does not match its service funding policy'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- The checkout records the rate it granted credits at: Stripe's live base rate
-- (with the fee-bearing exchange rate as evidence) or the accepted ECB snapshot.
ALTER TABLE billing_credit_top_up_checkouts
  ADD COLUMN fx_rate_source VARCHAR(10),
  ADD COLUMN fx_base_rate DECIMAL(38,18),
  ADD COLUMN fx_exchange_rate DECIMAL(38,18),
  ADD COLUMN fx_quote_id VARCHAR(255),
  ADD COLUMN fx_snapshot_id TEXT,
  ADD CONSTRAINT billing_credit_top_up_checkouts_fx_snapshot FOREIGN KEY (fx_snapshot_id)
    REFERENCES billing_sms_fx_snapshots(id) ON DELETE RESTRICT,
  DROP CONSTRAINT billing_credit_top_up_checkouts_fixed_conversion_check,
  -- COALESCE: a comparison with a missing rate is unknown, and a CHECK passes unknown.
  ADD CONSTRAINT billing_credit_top_up_checkouts_fixed_conversion_check CHECK (COALESCE(
    payment_amount_minor > 0 AND (
      (currency = 'USD' AND credits_received_microcredits::numeric = payment_amount_minor::numeric * 10000000
        AND fx_rate_source IS NULL AND fx_base_rate IS NULL AND fx_exchange_rate IS NULL
        AND fx_quote_id IS NULL AND fx_snapshot_id IS NULL)
      OR (currency IN ('EUR', 'GBP') AND credits_received_microcredits > 0
        AND credits_received_microcredits % 1000000 = 0 AND fx_base_rate > 0
        AND ((fx_rate_source = 'stripe' AND fx_quote_id ~ '^fxq_[A-Za-z0-9_]+$'
            AND fx_exchange_rate > 0 AND fx_snapshot_id IS NULL)
          OR (fx_rate_source = 'ecb' AND fx_snapshot_id IS NOT NULL AND fx_quote_id IS NULL
            AND fx_exchange_rate IS NULL)))), false));

-- A checkout's policy, catalog and payment share one currency. A USD checkout
-- grants its catalog's fixed credits; a GBP or EUR one grants what its stored
-- rate bought (the check above). The credit account and its entries stay USD.
CREATE OR REPLACE FUNCTION "billing_credit_top_up_checkout_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_row "billing_credit_accounts"%ROWTYPE;
  customer_row "billing_stripe_customers"%ROWTYPE;
  offer_row "billing_credit_top_up_offers"%ROWTYPE;
  policy_row "billing_credit_funding_policies"%ROWTYPE;
  catalog_row "billing_credit_top_up_catalogs"%ROWTYPE;
  entry_row "billing_credit_entries"%ROWTYPE;
  completion_event_row "billing_stripe_webhook_events"%ROWTYPE;
  account_livemode BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' AND (
    NEW."status" IS DISTINCT FROM 'CREATING'
    OR NEW."stripe_checkout_session_id" IS NOT NULL
    OR NEW."stripe_payment_intent_id" IS NOT NULL
    OR NEW."completion_webhook_event_id" IS NOT NULL
    OR NEW."completed_at" IS NOT NULL
    OR NEW."credit_entry_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'new credit checkout must begin creating without payment proof'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'COMPLETE' THEN
    IF ROW(
      NEW."status", NEW."stripe_checkout_session_id", NEW."stripe_payment_intent_id",
      NEW."completion_webhook_event_id", NEW."completed_at", NEW."credit_entry_id"
    ) IS DISTINCT FROM ROW(
      OLD."status", OLD."stripe_checkout_session_id", OLD."stripe_payment_intent_id",
      OLD."completion_webhook_event_id", OLD."completed_at", OLD."credit_entry_id"
    ) THEN
      RAISE EXCEPTION 'completed credit checkout proof is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO credit_row FROM "billing_credit_accounts"
    WHERE "id" = NEW."credit_account_id";
  SELECT * INTO customer_row FROM "billing_stripe_customers"
    WHERE "id" = NEW."customer_id";
  SELECT * INTO offer_row FROM "billing_credit_top_up_offers"
    WHERE "id" = NEW."offer_id";
  SELECT * INTO policy_row FROM "billing_credit_funding_policies"
    WHERE "id" = offer_row."policy_id";
  SELECT * INTO catalog_row FROM "billing_credit_top_up_catalogs"
    WHERE "id" = NEW."catalog_id";
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
     OR customer_row."org_id" IS DISTINCT FROM credit_row."org_id"
     OR customer_row."team_id" IS DISTINCT FROM credit_row."team_id"
     OR customer_row."scope" IS DISTINCT FROM credit_row."scope"
     OR offer_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR policy_row."id" IS NULL
     OR policy_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR policy_row."currency" IS DISTINCT FROM NEW."currency"
     OR NOT policy_row."top_up_enabled"
     OR catalog_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR catalog_row."key" IS DISTINCT FROM offer_row."catalog_key"
     OR catalog_row."version" IS DISTINCT FROM offer_row."catalog_version"
     OR catalog_row."currency" IS DISTINCT FROM NEW."currency"
     OR catalog_row."payment_amount_minor" IS DISTINCT FROM NEW."payment_amount_minor"
     OR catalog_row."payment_amount_minor" IS DISTINCT FROM offer_row."payment_amount_minor"
     OR (NEW."currency" = 'USD'
       AND catalog_row."credits_received_microcredits" IS DISTINCT FROM NEW."credits_received_microcredits")
     OR catalog_row."credits_received_microcredits" IS DISTINCT FROM offer_row."credits_received_microcredits"
     OR NEW."currency" NOT IN ('USD', 'EUR', 'GBP')
     OR (
       TG_OP = 'INSERT'
       AND (
         NOT policy_row."active"
         OR NOT offer_row."active"
         OR catalog_row."stripe_price_id" IS NULL
       )
     ) THEN
    RAISE EXCEPTION 'credit top-up checkout binding is incoherent'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'COMPLETE' THEN
    SELECT * INTO completion_event_row FROM "billing_stripe_webhook_events"
      WHERE "id" = NEW."completion_webhook_event_id";
    SELECT * INTO entry_row FROM "billing_credit_entries"
      WHERE "id" = NEW."credit_entry_id";
    IF completion_event_row."id" IS NULL
       OR completion_event_row."type" IS DISTINCT FROM 'payment_intent.succeeded'
       OR completion_event_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR completion_event_row."livemode" IS DISTINCT FROM account_livemode
       OR completion_event_row."stripe_object_id" IS DISTINCT FROM NEW."stripe_payment_intent_id"
       OR completion_event_row."stripe_checkout_session_id" IS DISTINCT FROM NEW."stripe_checkout_session_id"
       OR completion_event_row."stripe_payment_intent_id" IS DISTINCT FROM NEW."stripe_payment_intent_id"
       OR completion_event_row."stripe_customer_id" IS DISTINCT FROM customer_row."stripe_customer_id"
       OR completion_event_row."amount_minor" IS DISTINCT FROM NEW."payment_amount_minor"
       OR completion_event_row."currency" IS DISTINCT FROM NEW."currency"
       OR completion_event_row."stripe_created_at" IS DISTINCT FROM NEW."completed_at"
       OR entry_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
       OR entry_row."service_id" IS DISTINCT FROM NEW."service_id"
       OR entry_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
       OR entry_row."attributed_user_id" IS DISTINCT FROM NEW."requested_by_user_id"
       OR entry_row."kind" IS DISTINCT FROM 'TOP_UP'
       OR entry_row."direction" IS DISTINCT FROM 'CREDIT'
       OR entry_row."amount_microcredits" IS DISTINCT FROM NEW."credits_received_microcredits"
       OR entry_row."source_type" IS DISTINCT FROM 'credit_top_up_checkout'
       OR entry_row."source_id" IS DISTINCT FROM NEW."id" THEN
      RAISE EXCEPTION 'completed credit checkout does not match its immutable entry'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE billing_stripe_webhook_events
  DROP CONSTRAINT billing_stripe_webhook_events_verified_facts_check,
  ADD CONSTRAINT billing_stripe_webhook_events_verified_facts_check CHECK (
    (amount_minor IS NULL AND currency IS NULL)
    OR (amount_minor >= 0 AND currency IN ('USD', 'EUR', 'GBP')));

ALTER TABLE billing_sms_policy_alerts
  DROP CONSTRAINT sms_policy_alert_shape,
  ADD CONSTRAINT sms_policy_alert_shape CHECK (kind IN ('fx_unavailable', 'fx_outside_band',
      'fx_no_baseline', 'route_needs_operator', 'route_price_rose', 'route_price_unavailable',
      'monthly_price_below_cost', 'credit_fx_rate_unavailable')
    AND length(trim(subject)) > 0 AND length(trim(message)) > 0
    AND last_seen_at >= opened_at AND (resolved_at IS NULL OR resolved_at >= opened_at));
