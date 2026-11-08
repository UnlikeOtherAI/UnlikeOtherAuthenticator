BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
-- Add exact currency-specific ORG provider bindings. No existing customer,
-- subscription, wallet, financial row or immutable source is updated.
ALTER TABLE billing_stripe_customers DROP CONSTRAINT billing_stripe_customers_scope_check;
ALTER TABLE billing_stripe_customers ADD CONSTRAINT billing_stripe_customers_scope_check CHECK (
 (scope='ORGANISATION' AND team_id IS NULL AND (scope_key IN
   (org_id,org_id || ':sms:EUR',org_id || ':sms:GBP',org_id || ':sms:USD') OR
   length(scope_key)=length(org_id)+12 AND left(scope_key,length(org_id)+9)=org_id || ':billing:'
   AND right(scope_key,3) ~ '^[A-Z]{3}$')) OR
 (scope='TEAM' AND team_id IS NOT NULL AND scope_key=org_id || ':' || team_id));
CREATE OR REPLACE FUNCTION uoa_enforce_billing_stripe_scope_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."team_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "teams"
    WHERE "id" = NEW."team_id" AND "org_id" = NEW."org_id"
  ) THEN
    RAISE EXCEPTION 'Stripe billing team does not belong to organisation'
      USING ERRCODE = '23503';
  END IF;

  IF TG_TABLE_NAME = 'billing_stripe_checkout_sessions' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "billing_app_keys" app_key
      JOIN "billing_tariffs" tariff
        ON tariff."id" = NEW."tariff_id"
       AND tariff."service_id" = NEW."service_id"
      JOIN "billing_stripe_customers" customer
        ON customer."id" = NEW."customer_id"
       AND customer."account_id" = NEW."account_id"
       AND customer."org_id" = NEW."org_id"
       AND customer."team_id" IS NOT DISTINCT FROM NEW."team_id"
       AND customer."scope" = NEW."scope"
       AND (customer."scope_key" = NEW."scope_key" OR NEW.scope='ORGANISATION'
         AND customer.scope_key=NEW.org_id || ':billing:' || tariff.currency)
      WHERE app_key."id" = NEW."app_key_id"
        AND app_key."service_id" = NEW."service_id"
    ) THEN
      RAISE EXCEPTION 'Stripe checkout scope or account is incoherent'
        USING ERRCODE = '23503';
    END IF;
  ELSIF TG_TABLE_NAME = 'billing_stripe_subscriptions' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "billing_tariffs" tariff
      JOIN "billing_stripe_customers" customer
        ON customer."id" = NEW."customer_id"
       AND customer."account_id" = NEW."account_id"
       AND customer."org_id" = NEW."org_id"
       AND customer."team_id" IS NOT DISTINCT FROM NEW."team_id"
       AND customer."scope" = NEW."scope"
       AND (customer."scope_key" = NEW."scope_key" OR NEW.scope='ORGANISATION'
         AND customer.scope_key=NEW.org_id || ':billing:' || tariff.currency)
      JOIN "billing_stripe_checkout_sessions" checkout
        ON checkout."id" = NEW."checkout_id"
       AND checkout."account_id" = NEW."account_id"
       AND checkout."customer_id" = NEW."customer_id"
       AND checkout."service_id" = NEW."service_id"
       AND checkout."tariff_id" = NEW."tariff_id"
       AND checkout."tariff_source" = NEW."tariff_source"
       AND checkout."tariff_assignment_id" IS NOT DISTINCT FROM NEW."tariff_assignment_id"
       AND checkout."org_id" = NEW."org_id"
       AND checkout."team_id" IS NOT DISTINCT FROM NEW."team_id"
       AND checkout."scope" = NEW."scope"
       AND checkout."scope_key" = NEW."scope_key"
      WHERE tariff."id" = NEW."tariff_id"
        AND tariff."service_id" = NEW."service_id"
    ) THEN
      RAISE EXCEPTION 'Stripe subscription scope or account is incoherent'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "billing_recurring_addon_checkout_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  customer_row "billing_stripe_customers"%ROWTYPE;
  catalog_row "billing_recurring_addon_catalogs"%ROWTYPE;
  offer_row "billing_recurring_addon_offers"%ROWTYPE;
  completion_event_row "billing_stripe_webhook_events"%ROWTYPE;
  team_org_id TEXT;
  requester_is_manager BOOLEAN;
  account_livemode BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW."account_id" || ':' || NEW."service_id" || ':' || NEW."offer_key"
      || ':' || NEW."scope"::text || ':' || NEW."scope_key",
    0
  ));
  IF TG_OP = 'INSERT' AND (
    NEW."status" IS DISTINCT FROM 'CREATING'
    OR NEW."stripe_checkout_session_id" IS NOT NULL
    OR NEW."stripe_subscription_id" IS NOT NULL
    OR NEW."completion_webhook_event_id" IS NOT NULL
    OR NEW."completed_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'new recurring add-on checkout must begin creating without proof'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'COMPLETE' THEN
    IF ROW(
      NEW."status", NEW."stripe_checkout_session_id", NEW."stripe_subscription_id",
      NEW."completion_webhook_event_id", NEW."completed_at"
    ) IS DISTINCT FROM ROW(
      OLD."status", OLD."stripe_checkout_session_id", OLD."stripe_subscription_id",
      OLD."completion_webhook_event_id", OLD."completed_at"
    ) THEN
      RAISE EXCEPTION 'completed recurring add-on checkout proof is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO customer_row FROM "billing_stripe_customers"
    WHERE "id" = NEW."customer_id";
  SELECT * INTO catalog_row FROM "billing_recurring_addon_catalogs"
    WHERE "id" = NEW."catalog_id";
  SELECT * INTO offer_row FROM "billing_recurring_addon_offers"
    WHERE "id" = NEW."offer_id";
  SELECT "livemode" INTO account_livemode FROM "billing_stripe_accounts"
    WHERE "id" = NEW."account_id";
  PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");
  IF TG_OP = 'INSERT' THEN
    PERFORM "billing_assert_credit_app_key"(NEW."service_id", NEW."app_key_id");
    PERFORM billing_assert_org_financial_actor(NEW.org_id,NEW.requested_team_id,NEW.requested_by_user_id);
  END IF;

  IF NEW."scope" IN ('TEAM', 'SUBSCRIBING_USER') THEN
    SELECT "org_id" INTO team_org_id FROM "teams" WHERE "id" = NEW."team_id";
    IF team_org_id IS DISTINCT FROM NEW."org_id"
       OR NEW."requested_team_id" IS DISTINCT FROM NEW."team_id" THEN
      RAISE EXCEPTION 'recurring add-on team does not belong to the organisation'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."scope" = 'SUBSCRIBING_USER' THEN
      IF NEW."subscribing_user_id" IS DISTINCT FROM NEW."requested_by_user_id" THEN
        RAISE EXCEPTION 'user-scoped add-on checkout must belong to the authenticated subscriber'
          USING ERRCODE = '23514';
      END IF;
      PERFORM billing_assert_org_financial_actor(NEW.org_id,NEW.team_id,NEW.subscribing_user_id);
    END IF;
  END IF;

  IF length(btrim(NEW."actor_jti")) = 0
     OR customer_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR customer_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR (
       NEW."scope" = 'ORGANISATION'
       AND (customer_row."scope" IS DISTINCT FROM 'ORGANISATION' OR customer_row."team_id" IS NOT NULL)
     )
     OR (
       NEW."scope" IN ('TEAM', 'SUBSCRIBING_USER')
       AND ((NEW.billing_scope_epoch IS NULL AND (customer_row."scope" IS DISTINCT FROM 'TEAM' OR customer_row."team_id" IS DISTINCT FROM NEW."team_id"))
         OR (NEW.billing_scope_epoch IS NOT NULL AND (customer_row.scope IS DISTINCT FROM 'ORGANISATION'
           OR customer_row.team_id IS NOT NULL OR customer_row.scope_key NOT IN (NEW.org_id,NEW.org_id || ':billing:' || catalog_row.currency))))
     )
     OR catalog_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR catalog_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR catalog_row."offer_id" IS DISTINCT FROM NEW."offer_id"
     OR offer_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR offer_row."key" IS DISTINCT FROM NEW."offer_key"
     OR EXISTS (
       SELECT 1 FROM "billing_recurring_addon_subscriptions" AS subscription
       WHERE subscription."account_id" = NEW."account_id"
         AND subscription."service_id" = NEW."service_id"
         AND subscription."offer_key" = NEW."offer_key"
         AND subscription."scope" = NEW."scope"
         AND subscription."scope_key" = NEW."scope_key"
         AND subscription."status" NOT IN ('canceled', 'incomplete_expired')
     )
     OR (
       TG_OP = 'INSERT'
       AND (catalog_row."stripe_price_id" IS NULL OR NOT offer_row."active")
     ) THEN
    RAISE EXCEPTION 'recurring add-on checkout binding is incoherent'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'COMPLETE' THEN
    SELECT * INTO completion_event_row FROM "billing_stripe_webhook_events"
      WHERE "id" = NEW."completion_webhook_event_id";
    IF completion_event_row."id" IS NULL
       OR completion_event_row."type" IS DISTINCT FROM 'checkout.session.completed'
       OR completion_event_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR completion_event_row."livemode" IS DISTINCT FROM account_livemode
       OR completion_event_row."stripe_object_id" IS DISTINCT FROM NEW."stripe_checkout_session_id"
       OR completion_event_row."stripe_checkout_session_id" IS DISTINCT FROM NEW."stripe_checkout_session_id"
       OR completion_event_row."stripe_customer_id" IS DISTINCT FROM customer_row."stripe_customer_id"
       OR completion_event_row."stripe_subscription_id" IS DISTINCT FROM NEW."stripe_subscription_id"
       OR completion_event_row."stripe_created_at" IS DISTINCT FROM NEW."completed_at" THEN
      RAISE EXCEPTION 'completed recurring add-on checkout lacks exact Stripe evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


-- Last in trigger order: the existing org/mode write fence precedes the
-- customer lock. A concurrent legacy-customer capture cannot cross currencies.
CREATE FUNCTION guard_subscription_customer_currency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_currency text;v_key text;v_resource text;
BEGIN
 IF TG_TABLE_NAME='billing_stripe_checkout_sessions' THEN
   SELECT currency INTO v_currency FROM billing_tariffs WHERE id=NEW.tariff_id;
 ELSE
   SELECT c.currency,o.resource_kind INTO v_currency,v_resource FROM billing_recurring_addon_catalogs c
     JOIN billing_recurring_addon_offers o ON o.id=c.offer_id WHERE c.id=NEW.catalog_id;
 END IF;
 SELECT scope_key INTO v_key FROM billing_stripe_customers WHERE id=NEW.customer_id FOR UPDATE;
 IF v_key<>NEW.org_id AND v_key<>NEW.org_id || ':billing:' || v_currency AND
   NOT (COALESCE(v_resource,'')='sms_mobile_number' AND v_key=NEW.org_id || ':sms:' || v_currency) THEN
   RAISE EXCEPTION 'STRIPE_SUBSCRIPTION_CUSTOMER_CURRENCY_MISMATCH';
 END IF;
 IF EXISTS (SELECT 1 FROM billing_stripe_checkout_sessions c JOIN billing_tariffs t ON t.id=c.tariff_id
     WHERE c.customer_id=NEW.customer_id AND c.status IN ('creating','open') AND t.currency<>v_currency)
 OR EXISTS (SELECT 1 FROM billing_stripe_subscriptions s JOIN billing_tariffs t ON t.id=s.tariff_id
     WHERE s.customer_id=NEW.customer_id AND s.status NOT IN ('canceled','incomplete_expired') AND t.currency<>v_currency)
 OR EXISTS (SELECT 1 FROM billing_recurring_addon_checkouts c JOIN billing_recurring_addon_catalogs t ON t.id=c.catalog_id
     WHERE c.customer_id=NEW.customer_id AND c.status IN ('CREATING','OPEN','NEEDS_REVIEW') AND t.currency<>v_currency)
 OR EXISTS (SELECT 1 FROM billing_recurring_addon_subscriptions s JOIN billing_recurring_addon_catalogs t ON t.id=s.catalog_id
     WHERE s.customer_id=NEW.customer_id AND s.status NOT IN ('canceled','incomplete_expired') AND t.currency<>v_currency)
 THEN RAISE EXCEPTION 'STRIPE_SUBSCRIPTION_CUSTOMER_CURRENCY_CONFLICT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_subscription_customer_currency BEFORE INSERT ON billing_stripe_checkout_sessions
 FOR EACH ROW EXECUTE FUNCTION guard_subscription_customer_currency();
CREATE TRIGGER zz_addon_customer_currency BEFORE INSERT ON billing_recurring_addon_checkouts
 FOR EACH ROW EXECUTE FUNCTION guard_subscription_customer_currency();
COMMIT;
