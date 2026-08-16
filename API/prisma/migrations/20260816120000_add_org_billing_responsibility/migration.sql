-- Organisation billing responsibility.
--
-- Docs/plans/2026-08-15-org-billing-override.md. An organisation can take
-- billing over from all of its teams, across every service. Two structural
-- changes carry it:
--
--   1. `billing_org_responsibilities` — one row per organisation, the authority
--      record. Absent (or inactive) means today's behaviour exactly, so this
--      migration is inert until an organisation actually assumes billing.
--   2. `billing_credit_accounts` gains the `(scope, scope_key)` pair its
--      neighbours (tariff assignments, commercial adjustments, Stripe
--      customers and subscriptions) already carry, and `team_id` becomes NULL
--      exactly when the scope is ORGANISATION. Existing rows are TEAM-scoped
--      with `scope_key = org_id || ':' || team_id` and are otherwise unchanged.
--
-- Said out loud, per Docs/deployment.md "The billing tables defend themselves":
-- the backfill below temporarily disables `billing_credit_accounts_immutable_identity`
-- for one UPDATE. That guard freezes the identity column set, and `scope_key`
-- joins it; there is no way to populate a new identity column on existing rows
-- with the guard live. It is re-enabled in the same statement block, before any
-- other DDL, and no other trigger is touched.
--
-- The trigger functions below are the live definitions, re-issued with the
-- edits each one needs to admit an ORGANISATION-scoped account. Everything
-- else in them — every unrelated assertion — is byte-identical to the version
-- it replaces.

-- CreateTable
CREATE TABLE "billing_org_responsibilities" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "assumed_at" TIMESTAMP(3) NOT NULL,
    "assumed_by_user_id" TEXT NOT NULL,
    "released_at" TIMESTAMP(3),
    "released_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_org_responsibilities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_org_responsibilities_org_id_key" ON "billing_org_responsibilities"("org_id");

-- CreateIndex
CREATE INDEX "billing_org_responsibilities_active_idx" ON "billing_org_responsibilities"("active");

-- CreateIndex
CREATE INDEX "billing_org_responsibilities_assumed_by_user_id_idx" ON "billing_org_responsibilities"("assumed_by_user_id");

-- CreateIndex
CREATE INDEX "billing_org_responsibilities_released_by_user_id_idx" ON "billing_org_responsibilities"("released_by_user_id");

-- AddForeignKey
ALTER TABLE "billing_org_responsibilities" ADD CONSTRAINT "billing_org_responsibilities_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_org_responsibilities" ADD CONSTRAINT "billing_org_responsibilities_assumed_by_user_id_fkey" FOREIGN KEY ("assumed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_org_responsibilities" ADD CONSTRAINT "billing_org_responsibilities_released_by_user_id_fkey" FOREIGN KEY ("released_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A released record keeps its history: `active` false must carry the release,
-- and an active one must not claim to have been released.
ALTER TABLE "billing_org_responsibilities"
  ADD CONSTRAINT "billing_org_responsibilities_release_check"
  CHECK (
    ("active" AND "released_at" IS NULL AND "released_by_user_id" IS NULL)
    OR (NOT "active" AND "released_at" IS NOT NULL AND "released_by_user_id" IS NOT NULL)
  );

ALTER TABLE "billing_org_responsibilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_org_responsibilities" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "billing_org_responsibilities" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "billing_org_responsibilities" TO uoa_admin;
  END IF;
END;
$$;

-- The credit account's scope pair.
ALTER TABLE "billing_credit_accounts"
  ADD COLUMN "scope" "BillingAssignmentScope" NOT NULL DEFAULT 'TEAM',
  ADD COLUMN "scope_key" VARCHAR(520);

DO $$
BEGIN
  ALTER TABLE "billing_credit_accounts" DISABLE TRIGGER "billing_credit_accounts_immutable_identity";
  UPDATE "billing_credit_accounts"
    SET "scope_key" = "org_id" || ':' || "team_id"
    WHERE "scope_key" IS NULL;
  ALTER TABLE "billing_credit_accounts" ENABLE TRIGGER "billing_credit_accounts_immutable_identity";
END;
$$;

ALTER TABLE "billing_credit_accounts" ALTER COLUMN "scope_key" SET NOT NULL;
ALTER TABLE "billing_credit_accounts" ALTER COLUMN "team_id" DROP NOT NULL;

ALTER TABLE "billing_credit_accounts"
  ADD CONSTRAINT "billing_credit_accounts_scope_check"
  CHECK (
    (
      "scope" = 'TEAM'
      AND "team_id" IS NOT NULL
      AND "scope_key" = "org_id" || ':' || "team_id"
    )
    OR (
      "scope" = 'ORGANISATION'
      AND "team_id" IS NULL
      AND "scope_key" = "org_id"
    )
  );

-- `(account_id, team_id, currency)` cannot police an organisation account:
-- Postgres treats NULLs as distinct, so it would admit unlimited duplicates.
-- `scope_key` is never NULL and is unique per scope, so it is the honest key.
DROP INDEX "billing_credit_accounts_account_id_team_id_currency_key";
CREATE UNIQUE INDEX "billing_credit_accounts_account_id_scope_key_currency_key"
  ON "billing_credit_accounts"("account_id", "scope_key", "currency");
CREATE INDEX "billing_credit_accounts_org_id_scope_idx"
  ON "billing_credit_accounts"("org_id", "scope");

-- An organisation-scoped account's funding evidence carries no team.
ALTER TABLE "billing_credit_auto_top_up_consent_revisions" ALTER COLUMN "team_id" DROP NOT NULL;
ALTER TABLE "billing_credit_auto_top_up_disable_events" ALTER COLUMN "team_id" DROP NOT NULL;
ALTER TABLE "billing_credit_admin_adjustments" ALTER COLUMN "team_id" DROP NOT NULL;

-- Authority helpers. Each delegates to the existing exact-team helper whenever
-- a team is present, so team-scoped behaviour is unchanged by construction,
-- and answers the organisation question only when the scope has no team.
CREATE FUNCTION "billing_assert_credit_scope_manager"(
  expected_org_id TEXT,
  expected_team_id TEXT,
  expected_user_id TEXT
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF expected_team_id IS NOT NULL THEN
    PERFORM "billing_assert_credit_team_manager"(
      expected_org_id, expected_team_id, expected_user_id
    );
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "org_members" AS org_member
    WHERE org_member."org_id" = expected_org_id
      AND org_member."user_id" = expected_user_id
      AND org_member."status" = 'ACTIVE'
      AND (
        org_member."role" IN ('owner', 'admin')
        OR EXISTS (
          SELECT 1 FROM "organisations" AS organisation
          WHERE organisation."id" = expected_org_id
            AND organisation."owner_id" = expected_user_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'organisation-wide billing action requires an active organisation billing manager'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "billing_assert_credit_scope_user"(
  expected_org_id TEXT,
  expected_team_id TEXT,
  expected_user_id TEXT,
  require_active BOOLEAN
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF expected_team_id IS NOT NULL THEN
    PERFORM "billing_assert_credit_team_user"(
      expected_team_id, expected_user_id, require_active
    );
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "org_members" AS org_member
    WHERE org_member."org_id" = expected_org_id
      AND org_member."user_id" = expected_user_id
      AND (NOT require_active OR org_member."status" = 'ACTIVE')
  ) THEN
    RAISE EXCEPTION 'billing user is not a member of the exact organisation'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

-- billing_credit_account_coherence
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
       OR policy_row."currency" IS DISTINCT FROM 'USD'
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

-- billing_credit_consent_revision_coherence
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
     OR policy_row."currency" IS DISTINCT FROM 'USD'
     OR NOT policy_row."active"
     OR NOT policy_row."automatic_top_up_enabled"
     OR policy_row."automatic_consent_version" IS DISTINCT FROM NEW."consent_version"
     OR option_row."policy_id" IS DISTINCT FROM NEW."policy_id"
     OR option_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR option_row."refill_offer_id" IS DISTINCT FROM NEW."refill_offer_id"
     OR option_row."threshold_microcredits" IS DISTINCT FROM NEW."threshold_microcredits"
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

-- billing_credit_portfolio_snapshot_coherence
CREATE OR REPLACE FUNCTION "billing_credit_portfolio_snapshot_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_row "billing_credit_accounts"%ROWTYPE;
  latest_cursor TEXT;
  latest_captured_at TIMESTAMP(3);
  perspective_identifier TEXT;
BEGIN
  SELECT * INTO account_row
  FROM "billing_credit_accounts"
  WHERE "id" = NEW."credit_account_id"
  FOR UPDATE;
  SELECT "identifier" INTO perspective_identifier
  FROM "billing_services"
  WHERE "id" = NEW."perspective_service_id";
  IF NOT FOUND
     OR account_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR account_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR (
       account_row."scope" = 'TEAM'
       AND account_row."team_id" IS DISTINCT FROM NEW."team_id"
     )
     OR (
       account_row."scope" = 'ORGANISATION'
       AND NOT EXISTS (
         SELECT 1 FROM "teams" AS snapshot_team
         WHERE snapshot_team."id" = NEW."team_id"
           AND snapshot_team."org_id" = account_row."org_id"
       )
     )
     OR perspective_identifier IS DISTINCT FROM NEW."perspective_product" THEN
    RAISE EXCEPTION 'Ledger portfolio snapshot does not match the paying credit account'
      USING ERRCODE = '23514';
  END IF;
  SELECT snapshot."ledger_snapshot_cursor", snapshot."captured_at"
    INTO latest_cursor, latest_captured_at
  FROM "billing_credit_portfolio_snapshots" AS snapshot
  WHERE snapshot."credit_account_id" = NEW."credit_account_id"
    AND snapshot."billing_month" = NEW."billing_month"
  ORDER BY snapshot."captured_at" DESC, snapshot."ledger_snapshot_cursor" DESC
  LIMIT 1;
  IF latest_cursor IS NOT NULL
     AND NEW."ledger_snapshot_cursor" IS DISTINCT FROM latest_cursor
     AND NEW."captured_at" <= latest_captured_at THEN
    RAISE EXCEPTION 'stale Ledger portfolio snapshot cannot correct newer team usage'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- billing_credit_top_up_checkout_coherence
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
     OR policy_row."currency" IS DISTINCT FROM 'USD'
     OR NOT policy_row."top_up_enabled"
     OR catalog_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR catalog_row."key" IS DISTINCT FROM offer_row."catalog_key"
     OR catalog_row."version" IS DISTINCT FROM offer_row."catalog_version"
     OR catalog_row."currency" IS DISTINCT FROM 'USD'
     OR catalog_row."payment_amount_minor" IS DISTINCT FROM NEW."payment_amount_minor"
     OR catalog_row."payment_amount_minor" IS DISTINCT FROM offer_row."payment_amount_minor"
     OR catalog_row."credits_received_microcredits" IS DISTINCT FROM NEW."credits_received_microcredits"
     OR catalog_row."credits_received_microcredits" IS DISTINCT FROM offer_row."credits_received_microcredits"
     OR NEW."currency" <> 'USD'
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

-- billing_credit_setup_checkout_coherence
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
     OR policy_row."currency" IS DISTINCT FROM 'USD'
     OR NOT policy_row."automatic_top_up_enabled"
     OR policy_row."automatic_consent_version" IS DISTINCT FROM NEW."consent_version"
     OR option_row."policy_id" IS DISTINCT FROM NEW."policy_id"
     OR option_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR option_row."refill_offer_id" IS DISTINCT FROM NEW."refill_offer_id"
     OR option_row."threshold_microcredits" IS DISTINCT FROM NEW."threshold_microcredits"
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

-- billing_credit_usage_allocation_coherence
CREATE OR REPLACE FUNCTION "billing_credit_usage_allocation_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  adjustment_row "billing_credit_usage_settlement_adjustments"%ROWTYPE;
  settlement_row "billing_credit_usage_settlements"%ROWTYPE;
  credit_row "billing_credit_accounts"%ROWTYPE;
  previous_row "billing_credit_usage_allocations"%ROWTYPE;
BEGIN
  SELECT * INTO adjustment_row
  FROM "billing_credit_usage_settlement_adjustments"
  WHERE "id" = NEW."adjustment_id";
  SELECT * INTO settlement_row
  FROM "billing_credit_usage_settlements"
  WHERE "id" = NEW."settlement_id"
  FOR KEY SHARE;
  SELECT * INTO credit_row FROM "billing_credit_accounts"
    WHERE "id" = settlement_row."credit_account_id";
  IF adjustment_row."settlement_id" IS DISTINCT FROM NEW."settlement_id"
     OR adjustment_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR adjustment_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
     OR settlement_row."service_id" IS DISTINCT FROM NEW."service_id" THEN
    RAISE EXCEPTION 'usage allocation does not match its aggregate adjustment'
      USING ERRCODE = '23514';
  END IF;
  PERFORM "billing_assert_credit_app_key_provenance"(NEW."app_key_id", true);
  IF NEW."attributed_user_id" IS NOT NULL THEN
    PERFORM "billing_assert_credit_scope_user"(
      credit_row."org_id", credit_row."team_id", NEW."attributed_user_id", false
    );
  END IF;

  SELECT allocation.* INTO previous_row
  FROM "billing_credit_usage_allocations" AS allocation
  JOIN "billing_credit_usage_settlement_adjustments" AS adjustment
    ON adjustment."id" = allocation."adjustment_id"
  WHERE allocation."settlement_id" = NEW."settlement_id"
    AND allocation."adjustment_id" <> NEW."adjustment_id"
    AND allocation."attributed_user_id" IS NOT DISTINCT FROM NEW."attributed_user_id"
    AND adjustment."sequence" < adjustment_row."sequence"
  ORDER BY adjustment."sequence" DESC
  LIMIT 1;

  IF NEW."cumulative_rated_usage_amount_micro_minor"
       <> COALESCE(previous_row."cumulative_rated_usage_amount_micro_minor", 0)
          + NEW."delta_rated_usage_amount_micro_minor"
     OR NEW."cumulative_credits_consumed_microcredits"
       <> COALESCE(previous_row."cumulative_credits_consumed_microcredits", 0)
          + NEW."delta_credits_consumed_microcredits"
     OR NEW."cumulative_remaining_usage_amount_micro_minor"
       <> COALESCE(previous_row."cumulative_remaining_usage_amount_micro_minor", 0)
          + NEW."delta_remaining_usage_amount_micro_minor" THEN
    RAISE EXCEPTION 'usage allocation does not continue its per-user cumulative chain'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;

-- billing_credit_auto_top_up_generation_guard
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

-- billing_credit_auto_top_up_disable_event_coherence
CREATE OR REPLACE FUNCTION "billing_credit_auto_top_up_disable_event_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_row "billing_credit_accounts"%ROWTYPE;
  revision_row "billing_credit_auto_top_up_consent_revisions"%ROWTYPE;
  app_key_row "billing_app_keys"%ROWTYPE;
  organisation_row "organisations"%ROWTYPE;
  team_row "teams"%ROWTYPE;
  org_member_row "org_members"%ROWTYPE;
  team_member_row "team_members"%ROWTYPE;
BEGIN
  SELECT * INTO credit_row
  FROM "billing_credit_accounts"
  WHERE "id" = NEW."credit_account_id"
  FOR UPDATE;
  SELECT * INTO app_key_row
  FROM "billing_app_keys"
  WHERE "id" = NEW."app_key_id"
  FOR UPDATE;
  SELECT * INTO organisation_row
  FROM "organisations"
  WHERE "id" = NEW."org_id"
  FOR UPDATE;
  SELECT * INTO team_row
  FROM "teams"
  WHERE "id" = NEW."team_id"
  FOR UPDATE;
  SELECT * INTO org_member_row
  FROM "org_members"
  WHERE "org_id" = NEW."org_id"
    AND "user_id" = NEW."requested_by_user_id"
  FOR UPDATE;
  SELECT * INTO team_member_row
  FROM "team_members"
  WHERE "team_id" = NEW."team_id"
    AND "user_id" = NEW."requested_by_user_id"
  FOR UPDATE;
  SELECT * INTO revision_row
  FROM "billing_credit_auto_top_up_consent_revisions"
  WHERE "id" = NEW."previous_consent_revision_id";

  IF credit_row."id" IS NULL
     OR credit_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR credit_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR credit_row."team_id" IS DISTINCT FROM NEW."team_id"
     OR credit_row."auto_top_up_state" = 'DISABLED'
     OR credit_row."auto_top_up_generation" IS DISTINCT FROM NEW."previous_generation"
     OR credit_row."auto_top_up_consent_revision_id"
        IS DISTINCT FROM NEW."previous_consent_revision_id"
     OR revision_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
     OR app_key_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR app_key_row."purpose" IS DISTINCT FROM 'CUSTOMER_LIFECYCLE'
     OR app_key_row."revoked_at" IS NOT NULL
     OR (app_key_row."expires_at" IS NOT NULL AND app_key_row."expires_at" <= CURRENT_TIMESTAMP)
     OR organisation_row."id" IS NULL
     OR (NEW."team_id" IS NOT NULL AND team_row."org_id" IS DISTINCT FROM NEW."org_id")
     OR org_member_row."status" IS DISTINCT FROM 'ACTIVE'
     OR (NEW."team_id" IS NOT NULL AND team_member_row."status" IS DISTINCT FROM 'ACTIVE')
     OR NOT (
       org_member_row."role" IN ('owner', 'admin')
       OR (
         NEW."team_id" IS NOT NULL
         AND team_member_row."team_role" IN ('owner', 'admin')
       )
       OR organisation_row."owner_id" = NEW."requested_by_user_id"
     ) THEN
    RAISE EXCEPTION 'automatic top-up disable event lacks current exact authority'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
