-- Stripe projections created before this migration have no trustworthy account
-- identity. The collection gate has never been enabled, so fail closed rather
-- than guessing an account or mode for any unexpected rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "billing_stripe_customers")
    OR EXISTS (SELECT 1 FROM "billing_stripe_catalogs")
    OR EXISTS (SELECT 1 FROM "billing_stripe_tariff_prices")
    OR EXISTS (SELECT 1 FROM "billing_stripe_checkout_sessions")
    OR EXISTS (SELECT 1 FROM "billing_stripe_subscriptions")
    OR EXISTS (SELECT 1 FROM "billing_stripe_usage_exports")
    OR EXISTS (SELECT 1 FROM "billing_stripe_webhook_events")
  THEN
    RAISE EXCEPTION
      'Unbound Stripe projections must be removed before applying account-scoped billing';
  END IF;
END
$$;

CREATE TYPE "BillingTariffSource" AS ENUM (
  'SERVICE_DEFAULT',
  'ORGANISATION',
  'TEAM'
);

CREATE TABLE "billing_stripe_accounts" (
  "id" TEXT NOT NULL,
  "stripe_account_id" VARCHAR(255) NOT NULL,
  "livemode" BOOLEAN NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_stripe_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_stripe_accounts_stripe_account_id_livemode_key"
  ON "billing_stripe_accounts"("stripe_account_id", "livemode");

ALTER TABLE "billing_stripe_customers"
  ADD COLUMN "account_id" TEXT NOT NULL;
ALTER TABLE "billing_stripe_catalogs"
  ADD COLUMN "account_id" TEXT NOT NULL;
ALTER TABLE "billing_stripe_tariff_prices"
  ADD COLUMN "account_id" TEXT NOT NULL;
ALTER TABLE "billing_stripe_checkout_sessions"
  ADD COLUMN "account_id" TEXT NOT NULL,
  ADD COLUMN "tariff_source" "BillingTariffSource" NOT NULL,
  ADD COLUMN "tariff_assignment_id" TEXT,
  ADD COLUMN "lease_expires_at" TIMESTAMP(3) NOT NULL;
ALTER TABLE "billing_stripe_subscriptions"
  ADD COLUMN "account_id" TEXT NOT NULL,
  ADD COLUMN "checkout_id" TEXT NOT NULL,
  ADD COLUMN "tariff_source" "BillingTariffSource" NOT NULL,
  ADD COLUMN "tariff_assignment_id" TEXT;
ALTER TABLE "billing_stripe_usage_exports"
  ADD COLUMN "account_id" TEXT NOT NULL;

ALTER TABLE "billing_stripe_webhook_events"
  RENAME COLUMN "id" TO "stripe_event_id";
ALTER TABLE "billing_stripe_webhook_events"
  ADD COLUMN "id" TEXT NOT NULL,
  ADD COLUMN "account_id" TEXT NOT NULL;
ALTER TABLE "billing_stripe_webhook_events"
  DROP CONSTRAINT "billing_stripe_webhook_events_pkey";
ALTER TABLE "billing_stripe_webhook_events"
  ADD CONSTRAINT "billing_stripe_webhook_events_pkey" PRIMARY KEY ("id");

DROP INDEX "billing_stripe_customers_scope_key_key";
DROP INDEX "billing_stripe_customers_stripe_customer_id_key";
DROP INDEX "billing_stripe_catalogs_service_id_currency_key";
DROP INDEX "billing_stripe_catalogs_meter_event_name_key";
DROP INDEX "billing_stripe_catalogs_stripe_product_id_key";
DROP INDEX "billing_stripe_catalogs_stripe_meter_id_key";
DROP INDEX "billing_stripe_catalogs_stripe_usage_price_id_key";
DROP INDEX "billing_stripe_tariff_prices_tariff_id_key";
DROP INDEX "billing_stripe_tariff_prices_stripe_monthly_price_id_key";
DROP INDEX "billing_stripe_checkout_sessions_app_key_id_actor_jti_key";
DROP INDEX "billing_stripe_checkout_sessions_stripe_checkout_session_id_key";
DROP INDEX "billing_stripe_checkout_sessions_one_open_scope";
DROP INDEX "billing_stripe_subscriptions_stripe_subscription_id_key";
DROP INDEX "billing_stripe_subscriptions_one_live_scope";

CREATE UNIQUE INDEX "billing_stripe_customers_account_id_scope_key_key"
  ON "billing_stripe_customers"("account_id", "scope_key");
CREATE UNIQUE INDEX "billing_stripe_customers_account_id_stripe_customer_id_key"
  ON "billing_stripe_customers"("account_id", "stripe_customer_id");
CREATE INDEX "billing_stripe_customers_account_id_idx"
  ON "billing_stripe_customers"("account_id");

CREATE UNIQUE INDEX "billing_stripe_catalogs_account_id_service_id_currency_key"
  ON "billing_stripe_catalogs"("account_id", "service_id", "currency");
CREATE UNIQUE INDEX "billing_stripe_catalogs_account_id_meter_event_name_key"
  ON "billing_stripe_catalogs"("account_id", "meter_event_name");
CREATE UNIQUE INDEX "billing_stripe_catalogs_account_id_stripe_product_id_key"
  ON "billing_stripe_catalogs"("account_id", "stripe_product_id");
CREATE UNIQUE INDEX "billing_stripe_catalogs_account_id_stripe_meter_id_key"
  ON "billing_stripe_catalogs"("account_id", "stripe_meter_id");
CREATE UNIQUE INDEX "billing_stripe_catalogs_account_id_stripe_usage_price_id_key"
  ON "billing_stripe_catalogs"("account_id", "stripe_usage_price_id");
CREATE INDEX "billing_stripe_catalogs_account_id_idx"
  ON "billing_stripe_catalogs"("account_id");

CREATE UNIQUE INDEX "billing_stripe_tariff_prices_account_id_tariff_id_key"
  ON "billing_stripe_tariff_prices"("account_id", "tariff_id");
CREATE UNIQUE INDEX "billing_stripe_tariff_prices_account_id_stripe_monthly_price_id_key"
  ON "billing_stripe_tariff_prices"("account_id", "stripe_monthly_price_id");
CREATE INDEX "billing_stripe_tariff_prices_account_id_idx"
  ON "billing_stripe_tariff_prices"("account_id");

CREATE UNIQUE INDEX "billing_stripe_checkout_sessions_account_id_stripe_checkout_session_id_key"
  ON "billing_stripe_checkout_sessions"("account_id", "stripe_checkout_session_id");
CREATE INDEX "billing_stripe_checkout_sessions_account_id_app_key_id_actor_jti_idx"
  ON "billing_stripe_checkout_sessions"("account_id", "app_key_id", "actor_jti");
CREATE INDEX "billing_stripe_checkout_sessions_account_id_idx"
  ON "billing_stripe_checkout_sessions"("account_id");
CREATE UNIQUE INDEX "billing_stripe_checkout_sessions_one_open_scope"
  ON "billing_stripe_checkout_sessions"(
    "account_id",
    "service_id",
    "scope",
    "scope_key"
  )
  WHERE "status" IN ('creating', 'open');

CREATE UNIQUE INDEX "billing_stripe_subscriptions_checkout_id_key"
  ON "billing_stripe_subscriptions"("checkout_id");
CREATE UNIQUE INDEX "billing_stripe_subscriptions_account_id_stripe_subscription_id_key"
  ON "billing_stripe_subscriptions"("account_id", "stripe_subscription_id");
CREATE INDEX "billing_stripe_subscriptions_account_id_idx"
  ON "billing_stripe_subscriptions"("account_id");
CREATE UNIQUE INDEX "billing_stripe_subscriptions_one_live_scope"
  ON "billing_stripe_subscriptions"(
    "account_id",
    "service_id",
    "scope",
    "scope_key"
  )
  WHERE "status" NOT IN ('canceled', 'incomplete_expired');

CREATE INDEX "billing_stripe_usage_exports_account_id_idx"
  ON "billing_stripe_usage_exports"("account_id");
CREATE UNIQUE INDEX "billing_stripe_webhook_events_account_id_stripe_event_id_key"
  ON "billing_stripe_webhook_events"("account_id", "stripe_event_id");
CREATE INDEX "billing_stripe_webhook_events_account_id_idx"
  ON "billing_stripe_webhook_events"("account_id");

ALTER TABLE "billing_stripe_checkout_sessions"
  DROP CONSTRAINT "billing_stripe_checkout_sessions_status_check";
ALTER TABLE "billing_stripe_checkout_sessions"
  ADD CONSTRAINT "billing_stripe_checkout_sessions_status_check"
  CHECK ("status" IN ('creating', 'open', 'complete', 'expired', 'abandoned'));
ALTER TABLE "billing_stripe_checkout_sessions"
  ADD CONSTRAINT "billing_stripe_checkout_sessions_tariff_source_check"
  CHECK (
    (
      "tariff_source" = 'SERVICE_DEFAULT'
      AND "tariff_assignment_id" IS NULL
    )
    OR (
      "tariff_source" IN ('ORGANISATION', 'TEAM')
      AND "tariff_assignment_id" IS NOT NULL
    )
  );
ALTER TABLE "billing_stripe_subscriptions"
  ADD CONSTRAINT "billing_stripe_subscriptions_tariff_source_check"
  CHECK (
    (
      "tariff_source" = 'SERVICE_DEFAULT'
      AND "tariff_assignment_id" IS NULL
    )
    OR (
      "tariff_source" IN ('ORGANISATION', 'TEAM')
      AND "tariff_assignment_id" IS NOT NULL
    )
  );
ALTER TABLE "billing_stripe_tariff_prices"
  ADD CONSTRAINT "billing_stripe_tariff_prices_zero_monthly_check"
  CHECK (
    "monthly_amount_minor" > 0
    OR "stripe_monthly_price_id" IS NULL
  );

ALTER TABLE "billing_stripe_customers"
  ADD CONSTRAINT "billing_stripe_customers_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_catalogs"
  ADD CONSTRAINT "billing_stripe_catalogs_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_tariff_prices"
  ADD CONSTRAINT "billing_stripe_tariff_prices_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_checkout_sessions"
  ADD CONSTRAINT "billing_stripe_checkout_sessions_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_subscriptions"
  ADD CONSTRAINT "billing_stripe_subscriptions_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_subscriptions"
  ADD CONSTRAINT "billing_stripe_subscriptions_checkout_id_fkey"
  FOREIGN KEY ("checkout_id") REFERENCES "billing_stripe_checkout_sessions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_usage_exports"
  ADD CONSTRAINT "billing_stripe_usage_exports_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_stripe_webhook_events"
  ADD CONSTRAINT "billing_stripe_webhook_events_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id")
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
     AND catalog."account_id" = NEW."account_id"
     AND catalog."service_id" = tariff."service_id"
     AND catalog."currency" = tariff."currency"
    WHERE tariff."id" = NEW."tariff_id"
      AND tariff."monthly_amount_minor" = NEW."monthly_amount_minor"
      AND tariff."collection_mode" = 'STRIPE'
      AND tariff."mode" <> 'FREE'
  ) THEN
    RAISE EXCEPTION 'Stripe price does not match immutable tariff or account'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

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
       AND customer."scope_key" = NEW."scope_key"
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
       AND customer."scope_key" = NEW."scope_key"
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

CREATE OR REPLACE FUNCTION uoa_enforce_stripe_scope_exclusivity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  is_live BOOLEAN;
BEGIN
  is_live := CASE
    WHEN TG_TABLE_NAME = 'billing_stripe_checkout_sessions'
      THEN NEW."status" IN ('creating', 'open')
    ELSE NEW."status" NOT IN ('canceled', 'incomplete_expired')
  END;
  IF NOT is_live THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('uoa-stripe-service:' || NEW."service_id", 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'uoa-stripe-org:' || NEW."service_id" || ':' || NEW."org_id",
      0
    )
  );

  IF TG_TABLE_NAME = 'billing_stripe_checkout_sessions' THEN
    IF EXISTS (
      SELECT 1
      FROM "billing_stripe_checkout_sessions" other
      WHERE other."id" <> NEW."id"
        AND other."account_id" = NEW."account_id"
        AND other."service_id" = NEW."service_id"
        AND other."org_id" = NEW."org_id"
        AND other."status" IN ('creating', 'open')
        AND (
          NEW."scope" = 'ORGANISATION'
          OR other."scope" = 'ORGANISATION'
          OR other."scope_key" = NEW."scope_key"
        )
    ) THEN
      RAISE EXCEPTION 'Overlapping Stripe checkout already exists'
        USING ERRCODE = '23505';
    END IF;
  ELSIF EXISTS (
    SELECT 1
    FROM "billing_stripe_subscriptions" other
    WHERE other."id" <> NEW."id"
      AND other."account_id" = NEW."account_id"
      AND other."service_id" = NEW."service_id"
      AND other."org_id" = NEW."org_id"
      AND other."status" NOT IN ('canceled', 'incomplete_expired')
      AND (
        NEW."scope" = 'ORGANISATION'
        OR other."scope" = 'ORGANISATION'
        OR other."scope_key" = NEW."scope_key"
      )
  ) THEN
    RAISE EXCEPTION 'Overlapping Stripe subscription already exists'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_stripe_checkout_scope_exclusive
BEFORE INSERT OR UPDATE ON "billing_stripe_checkout_sessions"
FOR EACH ROW EXECUTE FUNCTION uoa_enforce_stripe_scope_exclusivity();
CREATE TRIGGER billing_stripe_subscription_scope_exclusive
BEFORE INSERT OR UPDATE ON "billing_stripe_subscriptions"
FOR EACH ROW EXECUTE FUNCTION uoa_enforce_stripe_scope_exclusivity();

CREATE OR REPLACE FUNCTION uoa_guard_stripe_default_tariff()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."is_default" IS NOT DISTINCT FROM OLD."is_default" THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('uoa-stripe-service:' || NEW."service_id", 0)
  );
  IF EXISTS (
    SELECT 1
    FROM "billing_stripe_checkout_sessions"
    WHERE "service_id" = NEW."service_id"
      AND "tariff_source" = 'SERVICE_DEFAULT'
      AND "status" IN ('creating', 'open')
  ) OR EXISTS (
    SELECT 1
    FROM "billing_stripe_subscriptions"
    WHERE "service_id" = NEW."service_id"
      AND "tariff_source" = 'SERVICE_DEFAULT'
      AND "status" NOT IN ('canceled', 'incomplete_expired')
  ) THEN
    RAISE EXCEPTION 'Stripe subscription pins the service default tariff'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_tariffs_stripe_default_pinned
BEFORE UPDATE OF "is_default" ON "billing_tariffs"
FOR EACH ROW EXECUTE FUNCTION uoa_guard_stripe_default_tariff();

CREATE OR REPLACE FUNCTION uoa_guard_stripe_tariff_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_service_id TEXT;
  candidate_org_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    candidate_service_id := OLD."service_id";
    candidate_org_id := OLD."org_id";
  ELSE
    candidate_service_id := NEW."service_id";
    candidate_org_id := NEW."org_id";
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('uoa-stripe-service:' || candidate_service_id, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'uoa-stripe-org:' || candidate_service_id || ':' || candidate_org_id,
      0
    )
  );

  IF TG_OP = 'DELETE' OR (
    TG_OP = 'UPDATE'
    AND NEW."tariff_id" IS DISTINCT FROM OLD."tariff_id"
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM "billing_stripe_checkout_sessions"
      WHERE "tariff_assignment_id" = OLD."id"
        AND "status" IN ('creating', 'open')
    ) OR EXISTS (
      SELECT 1
      FROM "billing_stripe_subscriptions"
      WHERE "tariff_assignment_id" = OLD."id"
        AND "status" NOT IN ('canceled', 'incomplete_expired')
    ) THEN
      RAISE EXCEPTION 'Stripe subscription pins this tariff assignment'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' AND NEW."scope" = 'TEAM' THEN
    IF EXISTS (
      SELECT 1
      FROM "billing_stripe_checkout_sessions"
      WHERE "service_id" = NEW."service_id"
        AND "org_id" = NEW."org_id"
        AND "scope" = 'ORGANISATION'
        AND "status" IN ('creating', 'open')
    ) OR EXISTS (
      SELECT 1
      FROM "billing_stripe_subscriptions"
      WHERE "service_id" = NEW."service_id"
        AND "org_id" = NEW."org_id"
        AND "scope" = 'ORGANISATION'
        AND "status" NOT IN ('canceled', 'incomplete_expired')
    ) THEN
      RAISE EXCEPTION 'Organisation Stripe subscription blocks team tariff override'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_OP <> 'DELETE' AND NEW."scope" = 'ORGANISATION' THEN
    IF EXISTS (
      SELECT 1
      FROM "billing_stripe_checkout_sessions"
      WHERE "service_id" = NEW."service_id"
        AND "org_id" = NEW."org_id"
        AND "scope" = 'ORGANISATION'
        AND "tariff_id" <> NEW."tariff_id"
        AND "status" IN ('creating', 'open')
    ) OR EXISTS (
      SELECT 1
      FROM "billing_stripe_subscriptions"
      WHERE "service_id" = NEW."service_id"
        AND "org_id" = NEW."org_id"
        AND "scope" = 'ORGANISATION'
        AND "tariff_id" <> NEW."tariff_id"
        AND "status" NOT IN ('canceled', 'incomplete_expired')
    ) THEN
      RAISE EXCEPTION 'Stripe subscription pins the organisation tariff'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER billing_tariff_assignments_stripe_pinned
BEFORE INSERT OR UPDATE OR DELETE ON "billing_tariff_assignments"
FOR EACH ROW EXECUTE FUNCTION uoa_guard_stripe_tariff_assignment();

REVOKE ALL ON TABLE "billing_stripe_accounts" FROM "uoa_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing_stripe_accounts" TO "uoa_admin";
ALTER TABLE "billing_stripe_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_stripe_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_stripe_accounts_deny_app ON "billing_stripe_accounts"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
