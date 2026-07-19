ALTER TABLE "billing_app_keys"
  ADD COLUMN "checkout_return_origins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "billing_stripe_customers" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT,
    "scope" "BillingAssignmentScope" NOT NULL,
    "scope_key" VARCHAR(520) NOT NULL,
    "stripe_customer_id" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "billing_stripe_customers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_stripe_customers_scope_check" CHECK (
      (
        "scope" = 'ORGANISATION'
        AND "team_id" IS NULL
        AND "scope_key" = "org_id"
      )
      OR (
        "scope" = 'TEAM'
        AND "team_id" IS NOT NULL
        AND "scope_key" = "org_id" || ':' || "team_id"
      )
    )
);

CREATE TABLE "billing_stripe_catalogs" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "meter_event_name" VARCHAR(100) NOT NULL,
    "stripe_product_id" VARCHAR(255),
    "stripe_meter_id" VARCHAR(255),
    "stripe_usage_price_id" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "billing_stripe_catalogs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_stripe_catalogs_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "billing_stripe_catalogs_event_name_check"
      CHECK ("meter_event_name" ~ '^[a-z0-9_]{1,100}$')
);

CREATE TABLE "billing_stripe_tariff_prices" (
    "id" TEXT NOT NULL,
    "tariff_id" TEXT NOT NULL,
    "catalog_id" TEXT NOT NULL,
    "monthly_amount_minor" BIGINT NOT NULL,
    "stripe_monthly_price_id" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_stripe_tariff_prices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_stripe_tariff_prices_amount_check" CHECK ("monthly_amount_minor" >= 0)
);

CREATE TABLE "billing_stripe_checkout_sessions" (
    "id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "tariff_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT,
    "scope" "BillingAssignmentScope" NOT NULL,
    "scope_key" VARCHAR(520) NOT NULL,
    "actor_jti" VARCHAR(256) NOT NULL,
    "requested_by_user_id" TEXT NOT NULL,
    "success_url_digest" CHAR(64) NOT NULL,
    "cancel_url_digest" CHAR(64) NOT NULL,
    "stripe_checkout_session_id" VARCHAR(255),
    "status" VARCHAR(32) NOT NULL DEFAULT 'creating',
    "expires_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "billing_stripe_checkout_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_stripe_checkout_sessions_status_check"
      CHECK ("status" IN ('creating', 'open', 'complete', 'expired')),
    CONSTRAINT "billing_stripe_checkout_sessions_scope_check" CHECK (
      (
        "scope" = 'ORGANISATION'
        AND "team_id" IS NULL
        AND "scope_key" = "org_id"
      )
      OR (
        "scope" = 'TEAM'
        AND "team_id" IS NOT NULL
        AND "scope_key" = "org_id" || ':' || "team_id"
      )
    ),
    CONSTRAINT "billing_stripe_checkout_sessions_actor_jti_check"
      CHECK (length("actor_jti") > 0),
    CONSTRAINT "billing_stripe_checkout_sessions_success_url_digest_check"
      CHECK ("success_url_digest" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "billing_stripe_checkout_sessions_cancel_url_digest_check"
      CHECK ("cancel_url_digest" ~ '^[a-f0-9]{64}$')
);

CREATE TABLE "billing_stripe_subscriptions" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "tariff_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT,
    "scope" "BillingAssignmentScope" NOT NULL,
    "scope_key" VARCHAR(520) NOT NULL,
    "stripe_subscription_id" VARCHAR(255) NOT NULL,
    "stripe_monthly_item_id" VARCHAR(255),
    "stripe_usage_item_id" VARCHAR(255) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "livemode" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "billing_stripe_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_stripe_subscriptions_status_check" CHECK (
      "status" IN (
        'incomplete',
        'incomplete_expired',
        'trialing',
        'active',
        'past_due',
        'canceled',
        'unpaid',
        'paused'
      )
    ),
    CONSTRAINT "billing_stripe_subscriptions_scope_check" CHECK (
      (
        "scope" = 'ORGANISATION'
        AND "team_id" IS NULL
        AND "scope_key" = "org_id"
      )
      OR (
        "scope" = 'TEAM'
        AND "team_id" IS NOT NULL
        AND "scope_key" = "org_id" || ':' || "team_id"
      )
    )
);

CREATE TABLE "billing_stripe_webhook_events" (
    "id" VARCHAR(255) NOT NULL,
    "type" VARCHAR(120) NOT NULL,
    "api_version" VARCHAR(32),
    "livemode" BOOLEAN NOT NULL,
    "stripe_created_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_stripe_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "billing_stripe_usage_exports" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "ledger_snapshot_cursor" VARCHAR(80) NOT NULL,
    "billing_month" CHAR(7) NOT NULL,
    "billing_product" VARCHAR(100) NOT NULL,
    "caller_product" VARCHAR(100) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "cumulative_customer_charge" VARCHAR(120) NOT NULL,
    "cumulative_meter_quantity" BIGINT NOT NULL,
    "delta_meter_quantity" BIGINT NOT NULL,
    "stripe_meter_event_identifier" VARCHAR(100) NOT NULL,
    "stripe_meter_event_created_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_stripe_usage_exports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_stripe_usage_exports_month_check"
      CHECK ("billing_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT "billing_stripe_usage_exports_product_check"
      CHECK (
        "billing_product" ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
        AND "caller_product" ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
      ),
    CONSTRAINT "billing_stripe_usage_exports_currency_check"
      CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "billing_stripe_usage_exports_amount_check"
      CHECK ("cumulative_customer_charge" ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'),
    CONSTRAINT "billing_stripe_usage_exports_quantity_check"
      CHECK (
        "cumulative_meter_quantity" >= 0
        AND "delta_meter_quantity" <> 0
      )
);

CREATE UNIQUE INDEX "billing_stripe_customers_scope_key_key"
  ON "billing_stripe_customers"("scope_key");
CREATE UNIQUE INDEX "billing_stripe_customers_stripe_customer_id_key"
  ON "billing_stripe_customers"("stripe_customer_id");
CREATE INDEX "billing_stripe_customers_org_id_idx"
  ON "billing_stripe_customers"("org_id");
CREATE INDEX "billing_stripe_customers_team_id_idx"
  ON "billing_stripe_customers"("team_id");

CREATE UNIQUE INDEX "billing_stripe_catalogs_service_id_currency_key"
  ON "billing_stripe_catalogs"("service_id", "currency");
CREATE UNIQUE INDEX "billing_stripe_catalogs_meter_event_name_key"
  ON "billing_stripe_catalogs"("meter_event_name");
CREATE UNIQUE INDEX "billing_stripe_catalogs_stripe_product_id_key"
  ON "billing_stripe_catalogs"("stripe_product_id");
CREATE UNIQUE INDEX "billing_stripe_catalogs_stripe_meter_id_key"
  ON "billing_stripe_catalogs"("stripe_meter_id");
CREATE UNIQUE INDEX "billing_stripe_catalogs_stripe_usage_price_id_key"
  ON "billing_stripe_catalogs"("stripe_usage_price_id");
CREATE INDEX "billing_stripe_catalogs_service_id_idx"
  ON "billing_stripe_catalogs"("service_id");

CREATE UNIQUE INDEX "billing_stripe_tariff_prices_tariff_id_key"
  ON "billing_stripe_tariff_prices"("tariff_id");
CREATE UNIQUE INDEX "billing_stripe_tariff_prices_stripe_monthly_price_id_key"
  ON "billing_stripe_tariff_prices"("stripe_monthly_price_id");
CREATE INDEX "billing_stripe_tariff_prices_catalog_id_idx"
  ON "billing_stripe_tariff_prices"("catalog_id");

CREATE UNIQUE INDEX "billing_stripe_checkout_sessions_app_key_id_actor_jti_key"
  ON "billing_stripe_checkout_sessions"("app_key_id", "actor_jti");
CREATE UNIQUE INDEX "billing_stripe_checkout_sessions_stripe_checkout_session_id_key"
  ON "billing_stripe_checkout_sessions"("stripe_checkout_session_id");
CREATE INDEX "billing_stripe_checkout_sessions_service_id_scope_scope_key_idx"
  ON "billing_stripe_checkout_sessions"("service_id", "scope", "scope_key");
CREATE UNIQUE INDEX "billing_stripe_checkout_sessions_one_open_scope"
  ON "billing_stripe_checkout_sessions"("service_id", "scope", "scope_key")
  WHERE "status" IN ('creating', 'open');
CREATE INDEX "billing_stripe_checkout_sessions_customer_id_idx"
  ON "billing_stripe_checkout_sessions"("customer_id");
CREATE INDEX "billing_stripe_checkout_sessions_org_id_idx"
  ON "billing_stripe_checkout_sessions"("org_id");
CREATE INDEX "billing_stripe_checkout_sessions_team_id_idx"
  ON "billing_stripe_checkout_sessions"("team_id");
CREATE INDEX "billing_stripe_checkout_sessions_requested_by_user_id_idx"
  ON "billing_stripe_checkout_sessions"("requested_by_user_id");

CREATE UNIQUE INDEX "billing_stripe_subscriptions_stripe_subscription_id_key"
  ON "billing_stripe_subscriptions"("stripe_subscription_id");
CREATE UNIQUE INDEX "billing_stripe_subscriptions_one_live_scope"
  ON "billing_stripe_subscriptions"("service_id", "scope", "scope_key")
  WHERE "status" NOT IN ('canceled', 'incomplete_expired');
CREATE INDEX "billing_stripe_subscriptions_service_id_scope_scope_key_idx"
  ON "billing_stripe_subscriptions"("service_id", "scope", "scope_key");
CREATE INDEX "billing_stripe_subscriptions_customer_id_idx"
  ON "billing_stripe_subscriptions"("customer_id");
CREATE INDEX "billing_stripe_subscriptions_tariff_id_idx"
  ON "billing_stripe_subscriptions"("tariff_id");
CREATE INDEX "billing_stripe_subscriptions_org_id_idx"
  ON "billing_stripe_subscriptions"("org_id");
CREATE INDEX "billing_stripe_subscriptions_team_id_idx"
  ON "billing_stripe_subscriptions"("team_id");
CREATE INDEX "billing_stripe_webhook_events_type_received_at_idx"
  ON "billing_stripe_webhook_events"("type", "received_at");
CREATE UNIQUE INDEX "billing_stripe_usage_exports_stripe_meter_event_identifier_key"
  ON "billing_stripe_usage_exports"("stripe_meter_event_identifier");
CREATE UNIQUE INDEX "billing_stripe_usage_exports_subscription_id_ledger_snapshot_cursor_caller_product_currency_key"
  ON "billing_stripe_usage_exports"(
    "subscription_id",
    "ledger_snapshot_cursor",
    "caller_product",
    "currency"
  );
CREATE INDEX "billing_stripe_usage_exports_subscription_id_billing_month_caller_product_currency_created_at_idx"
  ON "billing_stripe_usage_exports"(
    "subscription_id",
    "billing_month",
    "caller_product",
    "currency",
    "created_at"
  );

ALTER TABLE "billing_stripe_customers"
  ADD CONSTRAINT "billing_stripe_customers_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_customers"
  ADD CONSTRAINT "billing_stripe_customers_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_catalogs"
  ADD CONSTRAINT "billing_stripe_catalogs_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_tariff_prices"
  ADD CONSTRAINT "billing_stripe_tariff_prices_tariff_id_fkey"
  FOREIGN KEY ("tariff_id") REFERENCES "billing_tariffs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_tariff_prices"
  ADD CONSTRAINT "billing_stripe_tariff_prices_catalog_id_fkey"
  FOREIGN KEY ("catalog_id") REFERENCES "billing_stripe_catalogs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_checkout_sessions"
  ADD CONSTRAINT "billing_stripe_checkout_sessions_app_key_id_fkey"
  FOREIGN KEY ("app_key_id") REFERENCES "billing_app_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_checkout_sessions"
  ADD CONSTRAINT "billing_stripe_checkout_sessions_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "billing_stripe_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_checkout_sessions"
  ADD CONSTRAINT "billing_stripe_checkout_sessions_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_checkout_sessions"
  ADD CONSTRAINT "billing_stripe_checkout_sessions_tariff_id_fkey"
  FOREIGN KEY ("tariff_id") REFERENCES "billing_tariffs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_checkout_sessions"
  ADD CONSTRAINT "billing_stripe_checkout_sessions_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_checkout_sessions"
  ADD CONSTRAINT "billing_stripe_checkout_sessions_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_checkout_sessions"
  ADD CONSTRAINT "billing_stripe_checkout_sessions_requested_by_user_id_fkey"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_subscriptions"
  ADD CONSTRAINT "billing_stripe_subscriptions_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "billing_stripe_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_subscriptions"
  ADD CONSTRAINT "billing_stripe_subscriptions_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_subscriptions"
  ADD CONSTRAINT "billing_stripe_subscriptions_tariff_id_fkey"
  FOREIGN KEY ("tariff_id") REFERENCES "billing_tariffs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_subscriptions"
  ADD CONSTRAINT "billing_stripe_subscriptions_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_subscriptions"
  ADD CONSTRAINT "billing_stripe_subscriptions_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_usage_exports"
  ADD CONSTRAINT "billing_stripe_usage_exports_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "billing_stripe_subscriptions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION uoa_enforce_billing_stripe_price_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "billing_tariffs" tariff
    JOIN "billing_stripe_catalogs" catalog
      ON catalog."id" = NEW."catalog_id"
     AND catalog."service_id" = tariff."service_id"
     AND catalog."currency" = tariff."currency"
    WHERE tariff."id" = NEW."tariff_id"
      AND tariff."monthly_amount_minor" = NEW."monthly_amount_minor"
      AND tariff."collection_mode" = 'STRIPE'
      AND tariff."mode" <> 'FREE'
  ) THEN
    RAISE EXCEPTION 'Stripe price does not match immutable tariff'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_stripe_tariff_prices_coherent
BEFORE INSERT OR UPDATE ON "billing_stripe_tariff_prices"
FOR EACH ROW EXECUTE FUNCTION uoa_enforce_billing_stripe_price_coherence();

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
       AND customer."org_id" = NEW."org_id"
       AND customer."team_id" IS NOT DISTINCT FROM NEW."team_id"
       AND customer."scope" = NEW."scope"
       AND customer."scope_key" = NEW."scope_key"
      WHERE app_key."id" = NEW."app_key_id"
        AND app_key."service_id" = NEW."service_id"
    ) THEN
      RAISE EXCEPTION 'Stripe checkout scope is incoherent'
        USING ERRCODE = '23503';
    END IF;
  ELSIF TG_TABLE_NAME = 'billing_stripe_subscriptions' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "billing_tariffs" tariff
      JOIN "billing_stripe_customers" customer
        ON customer."id" = NEW."customer_id"
       AND customer."org_id" = NEW."org_id"
       AND customer."team_id" IS NOT DISTINCT FROM NEW."team_id"
       AND customer."scope" = NEW."scope"
       AND customer."scope_key" = NEW."scope_key"
      WHERE tariff."id" = NEW."tariff_id"
        AND tariff."service_id" = NEW."service_id"
    ) THEN
      RAISE EXCEPTION 'Stripe subscription scope is incoherent'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_stripe_customers_coherent
BEFORE INSERT OR UPDATE ON "billing_stripe_customers"
FOR EACH ROW EXECUTE FUNCTION uoa_enforce_billing_stripe_scope_coherence();
CREATE TRIGGER billing_stripe_checkout_sessions_coherent
BEFORE INSERT OR UPDATE ON "billing_stripe_checkout_sessions"
FOR EACH ROW EXECUTE FUNCTION uoa_enforce_billing_stripe_scope_coherence();
CREATE TRIGGER billing_stripe_subscriptions_coherent
BEFORE INSERT OR UPDATE ON "billing_stripe_subscriptions"
FOR EACH ROW EXECUTE FUNCTION uoa_enforce_billing_stripe_scope_coherence();

REVOKE ALL ON TABLE "billing_stripe_customers" FROM "uoa_app";
REVOKE ALL ON TABLE "billing_stripe_catalogs" FROM "uoa_app";
REVOKE ALL ON TABLE "billing_stripe_tariff_prices" FROM "uoa_app";
REVOKE ALL ON TABLE "billing_stripe_checkout_sessions" FROM "uoa_app";
REVOKE ALL ON TABLE "billing_stripe_subscriptions" FROM "uoa_app";
REVOKE ALL ON TABLE "billing_stripe_webhook_events" FROM "uoa_app";
REVOKE ALL ON TABLE "billing_stripe_usage_exports" FROM "uoa_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing_stripe_customers" TO "uoa_admin";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing_stripe_catalogs" TO "uoa_admin";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing_stripe_tariff_prices" TO "uoa_admin";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing_stripe_checkout_sessions" TO "uoa_admin";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing_stripe_subscriptions" TO "uoa_admin";
GRANT SELECT, INSERT ON TABLE "billing_stripe_webhook_events" TO "uoa_admin";
GRANT SELECT, INSERT, UPDATE ON TABLE "billing_stripe_usage_exports" TO "uoa_admin";

ALTER TABLE "billing_stripe_customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_stripe_customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_stripe_customers_deny_app ON "billing_stripe_customers"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
ALTER TABLE "billing_stripe_catalogs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_stripe_catalogs" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_stripe_catalogs_deny_app ON "billing_stripe_catalogs"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
ALTER TABLE "billing_stripe_tariff_prices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_stripe_tariff_prices" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_stripe_tariff_prices_deny_app ON "billing_stripe_tariff_prices"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
ALTER TABLE "billing_stripe_checkout_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_stripe_checkout_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_stripe_checkout_sessions_deny_app ON "billing_stripe_checkout_sessions"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
ALTER TABLE "billing_stripe_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_stripe_subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_stripe_subscriptions_deny_app ON "billing_stripe_subscriptions"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
ALTER TABLE "billing_stripe_webhook_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_stripe_webhook_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_stripe_webhook_events_deny_app ON "billing_stripe_webhook_events"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
ALTER TABLE "billing_stripe_usage_exports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_stripe_usage_exports" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_stripe_usage_exports_deny_app ON "billing_stripe_usage_exports"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
