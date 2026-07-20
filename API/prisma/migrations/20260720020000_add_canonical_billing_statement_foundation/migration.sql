CREATE TYPE "BillingAdjustmentKind" AS ENUM ('ADD_ON', 'CREDIT');
CREATE TYPE "BillingAdjustmentCadence" AS ENUM ('ONE_TIME', 'MONTHLY');
CREATE TYPE "BillingCancellationIntentState" AS ENUM (
  'AVAILABLE',
  'PROCESSING',
  'COMPLETED'
);

CREATE TABLE "billing_service_accesses" (
  "id" TEXT NOT NULL,
  "service_id" TEXT NOT NULL,
  "app_key_id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "first_confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_confirmed_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  CONSTRAINT "billing_service_accesses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "billing_commercial_adjustments" (
  "id" TEXT NOT NULL,
  "service_id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "team_id" TEXT,
  "scope" "BillingAssignmentScope" NOT NULL,
  "scope_key" VARCHAR(520) NOT NULL,
  "key" VARCHAR(100) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "kind" "BillingAdjustmentKind" NOT NULL,
  "cadence" "BillingAdjustmentCadence" NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "deactivated_at" TIMESTAMP(3),
  "created_by_user_id" TEXT,
  "created_by_email" VARCHAR(200),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_commercial_adjustments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_commercial_adjustments_scope_check" CHECK (
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
  CONSTRAINT "billing_commercial_adjustments_key_check"
    CHECK ("key" ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  CONSTRAINT "billing_commercial_adjustments_amount_check"
    CHECK ("amount_minor" >= 0),
  CONSTRAINT "billing_commercial_adjustments_currency_check"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "billing_commercial_adjustments_period_check"
    CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
  CONSTRAINT "billing_commercial_adjustments_deactivation_check"
    CHECK (
      ("active" = true AND "deactivated_at" IS NULL)
      OR ("active" = false AND "deactivated_at" IS NOT NULL)
    )
);

CREATE TABLE "billing_cancellation_intents" (
  "id" TEXT NOT NULL,
  "token_digest" CHAR(64) NOT NULL,
  "app_key_id" TEXT NOT NULL,
  "service_id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "requested_by_user_id" TEXT NOT NULL,
  "direct_service_ids" TEXT[] NOT NULL,
  "direct_subscription_ids" TEXT[] NOT NULL,
  "indirect_service_ids" TEXT[] NOT NULL,
  "entitlement_fingerprint" CHAR(64) NOT NULL,
  "subscription_fingerprint" CHAR(64) NOT NULL,
  "state" "BillingCancellationIntentState" NOT NULL DEFAULT 'AVAILABLE',
  "idempotency_key" VARCHAR(200),
  "request_digest" CHAR(64),
  "result" JSONB,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_cancellation_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_cancellation_intents_token_digest_check"
    CHECK ("token_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "billing_cancellation_intents_entitlement_fingerprint_check"
    CHECK ("entitlement_fingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "billing_cancellation_intents_subscription_fingerprint_check"
    CHECK ("subscription_fingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "billing_cancellation_intents_request_digest_check"
    CHECK ("request_digest" IS NULL OR "request_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "billing_cancellation_intents_direct_targets_check" CHECK (
    cardinality("direct_service_ids") > 0
    AND cardinality("direct_service_ids") = cardinality("direct_subscription_ids")
  ),
  CONSTRAINT "billing_cancellation_intents_state_check" CHECK (
    (
      "state" = 'AVAILABLE'
      AND "idempotency_key" IS NULL
      AND "request_digest" IS NULL
      AND "result" IS NULL
      AND "consumed_at" IS NULL
    )
    OR (
      "state" = 'PROCESSING'
      AND "idempotency_key" IS NOT NULL
      AND "request_digest" IS NOT NULL
      AND "result" IS NULL
      AND "consumed_at" IS NOT NULL
    )
    OR (
      "state" = 'COMPLETED'
      AND "idempotency_key" IS NOT NULL
      AND "request_digest" IS NOT NULL
      AND "result" IS NOT NULL
      AND "consumed_at" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX "billing_service_accesses_service_id_team_id_user_id_key"
  ON "billing_service_accesses"("service_id", "team_id", "user_id");
CREATE INDEX "billing_service_accesses_org_id_team_id_active_idx"
  ON "billing_service_accesses"("org_id", "team_id", "active");
CREATE INDEX "billing_service_accesses_app_key_id_idx"
  ON "billing_service_accesses"("app_key_id");
CREATE INDEX "billing_service_accesses_user_id_idx"
  ON "billing_service_accesses"("user_id");

CREATE UNIQUE INDEX "billing_commercial_adjustments_service_id_scope_scope_key_key_starts_at_key"
  ON "billing_commercial_adjustments"(
    "service_id",
    "scope",
    "scope_key",
    "key",
    "starts_at"
  );
CREATE INDEX "billing_commercial_adjustments_org_id_team_id_active_starts_at_ends_at_idx"
  ON "billing_commercial_adjustments"(
    "org_id",
    "team_id",
    "active",
    "starts_at",
    "ends_at"
  );

CREATE UNIQUE INDEX "billing_cancellation_intents_token_digest_key"
  ON "billing_cancellation_intents"("token_digest");
CREATE UNIQUE INDEX "billing_cancellation_intents_app_key_id_idempotency_key_key"
  ON "billing_cancellation_intents"("app_key_id", "idempotency_key");
CREATE INDEX "billing_cancellation_intents_org_id_team_id_expires_at_idx"
  ON "billing_cancellation_intents"("org_id", "team_id", "expires_at");
CREATE INDEX "billing_cancellation_intents_requested_by_user_id_idx"
  ON "billing_cancellation_intents"("requested_by_user_id");

ALTER TABLE "billing_service_accesses"
  ADD CONSTRAINT "billing_service_accesses_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "billing_services"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_service_accesses"
  ADD CONSTRAINT "billing_service_accesses_app_key_id_fkey"
  FOREIGN KEY ("app_key_id") REFERENCES "billing_app_keys"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_service_accesses"
  ADD CONSTRAINT "billing_service_accesses_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_service_accesses"
  ADD CONSTRAINT "billing_service_accesses_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_service_accesses"
  ADD CONSTRAINT "billing_service_accesses_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "billing_commercial_adjustments"
  ADD CONSTRAINT "billing_commercial_adjustments_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "billing_services"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_commercial_adjustments"
  ADD CONSTRAINT "billing_commercial_adjustments_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_commercial_adjustments"
  ADD CONSTRAINT "billing_commercial_adjustments_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "billing_cancellation_intents"
  ADD CONSTRAINT "billing_cancellation_intents_app_key_id_fkey"
  FOREIGN KEY ("app_key_id") REFERENCES "billing_app_keys"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_cancellation_intents"
  ADD CONSTRAINT "billing_cancellation_intents_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "billing_services"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_cancellation_intents"
  ADD CONSTRAINT "billing_cancellation_intents_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_cancellation_intents"
  ADD CONSTRAINT "billing_cancellation_intents_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_cancellation_intents"
  ADD CONSTRAINT "billing_cancellation_intents_requested_by_user_id_fkey"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION uoa_enforce_canonical_billing_scope_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "teams"
    WHERE "id" = NEW."team_id"
      AND "org_id" = NEW."org_id"
  ) THEN
    RAISE EXCEPTION 'billing team does not belong to organisation'
      USING ERRCODE = '23503';
  END IF;

  IF TG_TABLE_NAME = 'billing_service_accesses' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "billing_app_keys"
      WHERE "id" = NEW."app_key_id"
        AND "service_id" = NEW."service_id"
    ) OR NOT EXISTS (
      SELECT 1
      FROM "org_members"
      WHERE "org_id" = NEW."org_id"
        AND "user_id" = NEW."user_id"
        AND "status" = 'ACTIVE'
    ) OR NOT EXISTS (
      SELECT 1
      FROM "team_members"
      WHERE "team_id" = NEW."team_id"
        AND "user_id" = NEW."user_id"
        AND "status" = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'billing direct access is incoherent'
        USING ERRCODE = '23503';
    END IF;
  ELSIF TG_TABLE_NAME = 'billing_cancellation_intents' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "billing_app_keys"
      WHERE "id" = NEW."app_key_id"
        AND "service_id" = NEW."service_id"
        AND "purpose" = 'CUSTOMER_LIFECYCLE'
    ) THEN
      RAISE EXCEPTION 'billing cancellation app key is incoherent'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_service_accesses_coherent
BEFORE INSERT OR UPDATE ON "billing_service_accesses"
FOR EACH ROW EXECUTE FUNCTION uoa_enforce_canonical_billing_scope_coherence();

CREATE TRIGGER billing_cancellation_intents_coherent
BEFORE INSERT OR UPDATE ON "billing_cancellation_intents"
FOR EACH ROW EXECUTE FUNCTION uoa_enforce_canonical_billing_scope_coherence();

CREATE OR REPLACE FUNCTION uoa_enforce_billing_adjustment_scope_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."team_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "teams"
    WHERE "id" = NEW."team_id"
      AND "org_id" = NEW."org_id"
  ) THEN
    RAISE EXCEPTION 'billing adjustment team does not belong to organisation'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_commercial_adjustments_coherent
BEFORE INSERT OR UPDATE ON "billing_commercial_adjustments"
FOR EACH ROW EXECUTE FUNCTION uoa_enforce_billing_adjustment_scope_coherence();

REVOKE ALL ON TABLE "billing_service_accesses" FROM "uoa_app";
REVOKE ALL ON TABLE "billing_commercial_adjustments" FROM "uoa_app";
REVOKE ALL ON TABLE "billing_cancellation_intents" FROM "uoa_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing_service_accesses" TO "uoa_admin";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing_commercial_adjustments" TO "uoa_admin";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing_cancellation_intents" TO "uoa_admin";

ALTER TABLE "billing_service_accesses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_service_accesses" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_service_accesses_deny_app ON "billing_service_accesses"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);

ALTER TABLE "billing_commercial_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_commercial_adjustments" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_commercial_adjustments_deny_app ON "billing_commercial_adjustments"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);

ALTER TABLE "billing_cancellation_intents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_cancellation_intents" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_cancellation_intents_deny_app ON "billing_cancellation_intents"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
