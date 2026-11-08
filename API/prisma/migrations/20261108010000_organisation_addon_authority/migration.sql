BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- Preserve every captured object/payment/lifecycle proof. Only fresh actor
-- authority and the new epoch's ORG payer branch change; old TEAM captures
-- still recover against their original customer/account binding.
CREATE FUNCTION billing_assert_org_financial_actor(p_org text,p_team text,p_user text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_org_manager boolean;
BEGIN
  PERFORM billing_assert_credit_scope_manager(p_org,p_team,p_user);
  SELECT (o.owner_id=p_user OR m.role IN ('owner','admin')) INTO v_org_manager
    FROM organisations o JOIN org_members m ON m.org_id=o.id
    WHERE o.id=p_org AND m.user_id=p_user AND m.status='ACTIVE';
  IF p_team IS NULL THEN
    IF NOT COALESCE(v_org_manager,false) THEN RAISE EXCEPTION 'BILLING_MANAGER_REQUIRED' USING ERRCODE='23514'; END IF;
  ELSE
    PERFORM id FROM teams WHERE id=p_team AND org_id=p_org AND lifecycle_status='ACTIVE' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_SUBJECT_NOT_ENTITLED' USING ERRCODE='23514'; END IF;
    IF NOT COALESCE(v_org_manager,false) THEN
      PERFORM id FROM team_members WHERE team_id=p_team AND user_id=p_user AND status='ACTIVE' FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_SUBJECT_NOT_ENTITLED' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
END $$;

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
           OR customer_row.team_id IS NOT NULL OR customer_row.scope_key IS DISTINCT FROM NEW.org_id)))
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

CREATE OR REPLACE FUNCTION "billing_recurring_addon_cancellation_intent_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  subscription_row "billing_recurring_addon_subscriptions"%ROWTYPE;
  requester_is_manager BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'billing-recurring-addon-cancel:' || NEW."subscription_id",
    0
  ));
  SELECT * INTO subscription_row
  FROM "billing_recurring_addon_subscriptions"
  WHERE "id" = NEW."subscription_id"
  FOR SHARE;

  PERFORM "billing_assert_credit_app_key_service"(NEW."service_id", NEW."app_key_id");
  IF TG_OP = 'INSERT' THEN
    PERFORM "billing_assert_credit_app_key"(NEW."service_id", NEW."app_key_id");
  END IF;

  IF subscription_row."id" IS NULL
     OR subscription_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR subscription_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR subscription_row."offer_id" IS DISTINCT FROM NEW."offer_id"
     OR subscription_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR subscription_row."team_id" IS DISTINCT FROM NEW."team_id"
     OR subscription_row."subscribing_user_id" IS DISTINCT FROM NEW."subscribing_user_id"
     OR subscription_row."scope" IS DISTINCT FROM NEW."scope"
     OR subscription_row."scope_key" IS DISTINCT FROM NEW."scope_key"
     OR length(btrim(NEW."actor_jti")) = 0 THEN
    RAISE EXCEPTION 'recurring add-on cancellation intent binding is incoherent'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM billing_assert_org_financial_actor(NEW.org_id,NEW.requested_team_id,NEW.requested_by_user_id);
    requester_is_manager := true;

    IF NOT requester_is_manager
       OR NEW."state" IS DISTINCT FROM 'AVAILABLE'
       OR NEW."confirmation_request_digest" IS NOT NULL
       OR NEW."result" IS NOT NULL
       OR NEW."consumed_at" IS NOT NULL
       OR NEW."expires_at" <= CURRENT_TIMESTAMP
       OR subscription_row."status" IN ('canceled', 'incomplete_expired')
       OR subscription_row."cancel_at_period_end" THEN
      RAISE EXCEPTION 'new recurring add-on cancellation intent is not available'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD."state" = 'AVAILABLE' THEN
      IF NEW."state" NOT IN ('AVAILABLE', 'PROCESSING', 'EXPIRED') THEN
        RAISE EXCEPTION 'recurring add-on cancellation intent transition is invalid'
          USING ERRCODE = '23514';
      END IF;
      IF NEW."state" = 'PROCESSING' AND OLD."expires_at" <= CURRENT_TIMESTAMP THEN
        RAISE EXCEPTION 'recurring add-on cancellation intent has expired'
          USING ERRCODE = '23514';
      END IF;
      IF NEW."state" = 'EXPIRED' AND OLD."expires_at" > CURRENT_TIMESTAMP THEN
        RAISE EXCEPTION 'recurring add-on cancellation intent is not expired'
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD."state" = 'PROCESSING' THEN
      IF NEW."state" NOT IN ('PROCESSING', 'COMPLETED')
         OR NEW."confirmation_request_digest"
            IS DISTINCT FROM OLD."confirmation_request_digest" THEN
        RAISE EXCEPTION 'recurring add-on cancellation processing proof is immutable'
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD."state" IN ('COMPLETED', 'EXPIRED') AND ROW(
      NEW."state", NEW."confirmation_request_digest", NEW."result", NEW."consumed_at"
    ) IS DISTINCT FROM ROW(
      OLD."state", OLD."confirmation_request_digest", OLD."result", OLD."consumed_at"
    ) THEN
      RAISE EXCEPTION 'completed recurring add-on cancellation proof is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF NEW."state" = 'COMPLETED'
       AND NOT (
         subscription_row."cancel_at_period_end"
         OR subscription_row."status" = 'canceled'
       ) THEN
      RAISE EXCEPTION 'completed cancellation requires the bound subscription to be canceled'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
