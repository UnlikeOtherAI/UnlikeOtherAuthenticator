CREATE TYPE "BillingTariffMode" AS ENUM ('STANDARD', 'FREE', 'AT_COST', 'CUSTOM');
CREATE TYPE "BillingAssignmentScope" AS ENUM ('ORGANISATION', 'TEAM');

CREATE TABLE "billing_services" (
    "id" TEXT NOT NULL,
    "identifier" VARCHAR(100) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "billing_services_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "billing_tariffs" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "version" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "mode" "BillingTariffMode" NOT NULL,
    "markup_bps" INTEGER NOT NULL,
    "monthly_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" TEXT,
    "created_by_email" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_tariffs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_tariffs_version_check" CHECK ("version" > 0),
    CONSTRAINT "billing_tariffs_markup_check" CHECK ("markup_bps" BETWEEN 0 AND 100000),
    CONSTRAINT "billing_tariffs_monthly_amount_check" CHECK ("monthly_amount_minor" >= 0),
    CONSTRAINT "billing_tariffs_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "billing_tariffs_mode_values_check" CHECK (
      ("mode" = 'FREE' AND "markup_bps" = 0 AND "monthly_amount_minor" = 0)
      OR ("mode" = 'AT_COST' AND "markup_bps" = 0)
      OR "mode" IN ('STANDARD', 'CUSTOM')
    )
);

CREATE TABLE "billing_tariff_assignments" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "tariff_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT,
    "scope" "BillingAssignmentScope" NOT NULL,
    "scope_key" VARCHAR(520) NOT NULL,
    "created_by_user_id" TEXT,
    "created_by_email" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "billing_tariff_assignments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_tariff_assignments_scope_check" CHECK (
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

CREATE TABLE "billing_app_keys" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "key_prefix" VARCHAR(24) NOT NULL,
    "secret_digest" TEXT NOT NULL,
    "actor_issuer" VARCHAR(2048) NOT NULL,
    "actor_audience" VARCHAR(2048) NOT NULL,
    "actor_key_id" VARCHAR(256) NOT NULL,
    "actor_public_jwk" JSONB NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "created_by_email" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "billing_app_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_services_identifier_key" ON "billing_services"("identifier");
CREATE UNIQUE INDEX "billing_tariffs_service_id_key_version_key" ON "billing_tariffs"("service_id", "key", "version");
CREATE INDEX "billing_tariffs_service_id_is_default_idx" ON "billing_tariffs"("service_id", "is_default");
CREATE UNIQUE INDEX "billing_tariffs_one_default_per_service" ON "billing_tariffs"("service_id") WHERE "is_default" = true;
CREATE UNIQUE INDEX "billing_tariff_assignments_service_id_scope_scope_key_key" ON "billing_tariff_assignments"("service_id", "scope", "scope_key");
CREATE INDEX "billing_tariff_assignments_tariff_id_idx" ON "billing_tariff_assignments"("tariff_id");
CREATE INDEX "billing_tariff_assignments_org_id_idx" ON "billing_tariff_assignments"("org_id");
CREATE INDEX "billing_tariff_assignments_team_id_idx" ON "billing_tariff_assignments"("team_id");
CREATE UNIQUE INDEX "billing_app_keys_secret_digest_key" ON "billing_app_keys"("secret_digest");
CREATE INDEX "billing_app_keys_service_id_idx" ON "billing_app_keys"("service_id");

ALTER TABLE "billing_tariffs"
  ADD CONSTRAINT "billing_tariffs_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_tariff_assignments"
  ADD CONSTRAINT "billing_tariff_assignments_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_tariff_assignments"
  ADD CONSTRAINT "billing_tariff_assignments_tariff_id_fkey"
  FOREIGN KEY ("tariff_id") REFERENCES "billing_tariffs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_tariff_assignments"
  ADD CONSTRAINT "billing_tariff_assignments_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_tariff_assignments"
  ADD CONSTRAINT "billing_tariff_assignments_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_app_keys"
  ADD CONSTRAINT "billing_app_keys_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Commercial terms are append-only. The default pointer is the only mutable tariff field.
CREATE OR REPLACE FUNCTION uoa_enforce_billing_tariff_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'billing tariff versions are immutable';
  END IF;

  IF NEW."service_id" IS DISTINCT FROM OLD."service_id"
    OR NEW."key" IS DISTINCT FROM OLD."key"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."name" IS DISTINCT FROM OLD."name"
    OR NEW."mode" IS DISTINCT FROM OLD."mode"
    OR NEW."markup_bps" IS DISTINCT FROM OLD."markup_bps"
    OR NEW."monthly_amount_minor" IS DISTINCT FROM OLD."monthly_amount_minor"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
    OR NEW."created_by_email" IS DISTINCT FROM OLD."created_by_email"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'billing tariff version terms are immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_tariffs_immutable
BEFORE UPDATE OR DELETE ON "billing_tariffs"
FOR EACH ROW EXECUTE FUNCTION uoa_enforce_billing_tariff_immutability();

-- PostgreSQL CHECK constraints cannot query parent rows. This trigger closes the
-- two cross-table coherence gaps left by the scalar Prisma relations.
CREATE OR REPLACE FUNCTION uoa_enforce_billing_assignment_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "billing_tariffs"
    WHERE "id" = NEW."tariff_id"
      AND "service_id" = NEW."service_id"
  ) THEN
    RAISE EXCEPTION 'billing tariff does not belong to service'
      USING ERRCODE = '23503';
  END IF;

  IF NEW."team_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "teams"
    WHERE "id" = NEW."team_id"
      AND "org_id" = NEW."org_id"
  ) THEN
    RAISE EXCEPTION 'billing team does not belong to organisation'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_tariff_assignments_coherent
BEFORE INSERT OR UPDATE ON "billing_tariff_assignments"
FOR EACH ROW EXECUTE FUNCTION uoa_enforce_billing_assignment_coherence();

-- UOA's commercial control plane is only accessed through audited admin/service paths.
-- The runtime tenant role must never read credentials or mutate tariff state directly.
REVOKE ALL ON TABLE "billing_services" FROM "uoa_app";
REVOKE ALL ON TABLE "billing_tariffs" FROM "uoa_app";
REVOKE ALL ON TABLE "billing_tariff_assignments" FROM "uoa_app";
REVOKE ALL ON TABLE "billing_app_keys" FROM "uoa_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing_services" TO "uoa_admin";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing_tariffs" TO "uoa_admin";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing_tariff_assignments" TO "uoa_admin";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing_app_keys" TO "uoa_admin";

ALTER TABLE "billing_services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_services" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_services_deny_app ON "billing_services"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
ALTER TABLE "billing_tariffs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_tariffs" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_tariffs_deny_app ON "billing_tariffs"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
ALTER TABLE "billing_tariff_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_tariff_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_tariff_assignments_deny_app ON "billing_tariff_assignments"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
ALTER TABLE "billing_app_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_app_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_app_keys_deny_app ON "billing_app_keys"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
