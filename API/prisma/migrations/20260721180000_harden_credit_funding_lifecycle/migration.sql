-- Pin Setup Checkout to one exact consent predecessor and retain a database-
-- asserted manager audit event for every automatic-top-up disable transition.
ALTER TABLE "billing_credit_accounts"
  ADD COLUMN "auto_top_up_generation" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "billing_credit_accounts"
  ADD CONSTRAINT "billing_credit_accounts_auto_top_up_generation_check"
  CHECK ("auto_top_up_generation" >= 0);

ALTER TABLE "billing_credit_setup_checkouts"
  ADD COLUMN "expected_generation" INTEGER,
  ADD COLUMN "expected_consent_revision_id" TEXT;

DROP TRIGGER "billing_credit_setup_checkouts_immutable_snapshot"
  ON "billing_credit_setup_checkouts";

UPDATE "billing_credit_setup_checkouts" AS checkout
SET
  "expected_generation" = account."auto_top_up_generation",
  "expected_consent_revision_id" = account."auto_top_up_consent_revision_id"
FROM "billing_credit_accounts" AS account
WHERE account."id" = checkout."credit_account_id";

-- A legacy open setup was not pinned when it was created and can never be
-- allowed to supersede the current consent snapshot after this migration.
UPDATE "billing_credit_setup_checkouts"
SET "status" = 'ABANDONED', "updated_at" = CURRENT_TIMESTAMP
WHERE "status" IN ('CREATING', 'OPEN', 'NEEDS_REVIEW');

ALTER TABLE "billing_credit_setup_checkouts"
  ALTER COLUMN "expected_generation" SET NOT NULL,
  ADD CONSTRAINT "billing_credit_setup_checkouts_expected_generation_check"
    CHECK ("expected_generation" >= 0),
  ADD CONSTRAINT "billing_credit_setup_checkouts_expected_consent_fkey"
    FOREIGN KEY ("expected_consent_revision_id")
    REFERENCES "billing_credit_auto_top_up_consent_revisions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "billing_credit_setup_checkouts_expected_consent_idx"
  ON "billing_credit_setup_checkouts"("expected_consent_revision_id");

CREATE TRIGGER "billing_credit_setup_checkouts_immutable_snapshot"
  BEFORE UPDATE OR DELETE ON "billing_credit_setup_checkouts"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_funding_projection_identity"();

CREATE TABLE "billing_credit_auto_top_up_disable_events" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "credit_account_id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "service_id" TEXT NOT NULL,
  "app_key_id" TEXT NOT NULL,
  "previous_consent_revision_id" TEXT NOT NULL,
  "previous_generation" INTEGER NOT NULL,
  "actor_jti" VARCHAR(256) NOT NULL,
  "requested_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_credit_auto_top_up_disable_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_credit_auto_top_up_disable_events_generation_check"
    CHECK ("previous_generation" >= 0),
  CONSTRAINT "billing_credit_auto_top_up_disable_events_actor_check"
    CHECK (length(btrim("actor_jti")) > 0)
);

CREATE UNIQUE INDEX "billing_credit_auto_top_up_disable_events_actor_key"
  ON "billing_credit_auto_top_up_disable_events"("app_key_id", "actor_jti");
CREATE UNIQUE INDEX "billing_credit_auto_top_up_disable_events_generation_key"
  ON "billing_credit_auto_top_up_disable_events"("credit_account_id", "previous_generation");
CREATE INDEX "billing_credit_auto_top_up_disable_events_team_idx"
  ON "billing_credit_auto_top_up_disable_events"("org_id", "team_id", "created_at");
CREATE INDEX "billing_credit_auto_top_up_disable_events_requester_idx"
  ON "billing_credit_auto_top_up_disable_events"("requested_by_user_id");

ALTER TABLE "billing_credit_auto_top_up_disable_events"
  ADD CONSTRAINT "billing_credit_auto_top_up_disable_events_account_fkey"
    FOREIGN KEY ("account_id") REFERENCES "billing_stripe_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "billing_credit_auto_top_up_disable_events_credit_account_fkey"
    FOREIGN KEY ("credit_account_id") REFERENCES "billing_credit_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "billing_credit_auto_top_up_disable_events_org_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organisations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "billing_credit_auto_top_up_disable_events_team_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "billing_credit_auto_top_up_disable_events_service_fkey"
    FOREIGN KEY ("service_id") REFERENCES "billing_services"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "billing_credit_auto_top_up_disable_events_app_key_fkey"
    FOREIGN KEY ("app_key_id") REFERENCES "billing_app_keys"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "billing_credit_auto_top_up_disable_events_previous_consent_fkey"
    FOREIGN KEY ("previous_consent_revision_id")
    REFERENCES "billing_credit_auto_top_up_consent_revisions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "billing_credit_auto_top_up_disable_events_requester_fkey"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "billing_credit_setup_predecessor_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_row "billing_credit_accounts"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT'
     OR (TG_OP = 'UPDATE' AND OLD."status" <> 'COMPLETE' AND NEW."status" = 'COMPLETE') THEN
    SELECT * INTO credit_row
    FROM "billing_credit_accounts"
    WHERE "id" = NEW."credit_account_id"
    FOR UPDATE;
    IF credit_row."id" IS NULL
       OR credit_row."auto_top_up_generation" IS DISTINCT FROM NEW."expected_generation"
       OR credit_row."auto_top_up_consent_revision_id"
          IS DISTINCT FROM NEW."expected_consent_revision_id" THEN
      RAISE EXCEPTION 'automatic top-up setup predecessor changed'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_setup_checkouts_predecessor_guard"
  BEFORE INSERT OR UPDATE ON "billing_credit_setup_checkouts"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_setup_predecessor_guard"();

CREATE FUNCTION "billing_credit_auto_top_up_disable_event_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_row "billing_credit_accounts"%ROWTYPE;
  revision_row "billing_credit_auto_top_up_consent_revisions"%ROWTYPE;
BEGIN
  SELECT * INTO credit_row
  FROM "billing_credit_accounts"
  WHERE "id" = NEW."credit_account_id"
  FOR UPDATE;
  SELECT * INTO revision_row
  FROM "billing_credit_auto_top_up_consent_revisions"
  WHERE "id" = NEW."previous_consent_revision_id";
  PERFORM "billing_assert_credit_app_key"(NEW."service_id", NEW."app_key_id");
  PERFORM "billing_assert_credit_team_manager"(
    NEW."org_id", NEW."team_id", NEW."requested_by_user_id"
  );
  IF credit_row."id" IS NULL
     OR credit_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR credit_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR credit_row."team_id" IS DISTINCT FROM NEW."team_id"
     OR credit_row."auto_top_up_state" = 'DISABLED'
     OR credit_row."auto_top_up_generation" IS DISTINCT FROM NEW."previous_generation"
     OR credit_row."auto_top_up_consent_revision_id"
        IS DISTINCT FROM NEW."previous_consent_revision_id"
     OR revision_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id" THEN
    RAISE EXCEPTION 'automatic top-up disable event does not match current consent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_auto_top_up_disable_events_coherence"
  BEFORE INSERT ON "billing_credit_auto_top_up_disable_events"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_auto_top_up_disable_event_coherence"();

CREATE FUNCTION "billing_credit_auto_top_up_disable_event_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'automatic top-up disable evidence is append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "billing_credit_auto_top_up_disable_events_append_only"
  BEFORE UPDATE OR DELETE ON "billing_credit_auto_top_up_disable_events"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_auto_top_up_disable_event_append_only"();

CREATE FUNCTION "billing_credit_auto_top_up_generation_guard"() RETURNS trigger
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
         AND disable_event."team_id" = OLD."team_id"
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

CREATE TRIGGER "billing_credit_accounts_auto_top_up_generation_guard"
  BEFORE INSERT OR UPDATE ON "billing_credit_accounts"
  FOR EACH ROW EXECUTE FUNCTION "billing_credit_auto_top_up_generation_guard"();

DROP TRIGGER "billing_credit_accounts_immutable_identity" ON "billing_credit_accounts";

CREATE FUNCTION "billing_guard_credit_account_identity_v2"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_identity JSONB;
  old_identity JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'billing_credit_accounts commercial history cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  new_identity := to_jsonb(NEW) - ARRAY[
    'balance_microcredits', 'auto_top_up_generation', 'auto_top_up_state',
    'auto_top_up_policy_id', 'auto_top_up_service_id', 'auto_top_up_app_key_id',
    'auto_top_up_consent_revision_id', 'auto_top_up_option_id',
    'auto_top_up_threshold_microcredits', 'auto_top_up_refill_offer_id',
    'auto_top_up_monthly_charge_cap_minor', 'auto_top_up_consent_version',
    'auto_top_up_consented_at', 'auto_top_up_consented_by_user_id',
    'stripe_payment_method_id', 'payment_method_summary', 'updated_at'
  ];
  old_identity := to_jsonb(OLD) - ARRAY[
    'balance_microcredits', 'auto_top_up_generation', 'auto_top_up_state',
    'auto_top_up_policy_id', 'auto_top_up_service_id', 'auto_top_up_app_key_id',
    'auto_top_up_consent_revision_id', 'auto_top_up_option_id',
    'auto_top_up_threshold_microcredits', 'auto_top_up_refill_offer_id',
    'auto_top_up_monthly_charge_cap_minor', 'auto_top_up_consent_version',
    'auto_top_up_consented_at', 'auto_top_up_consented_by_user_id',
    'stripe_payment_method_id', 'payment_method_summary', 'updated_at'
  ];
  IF new_identity IS DISTINCT FROM old_identity THEN
    RAISE EXCEPTION 'billing_credit_accounts identity and commercial snapshot are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_credit_accounts_immutable_identity"
  BEFORE UPDATE OR DELETE ON "billing_credit_accounts"
  FOR EACH ROW EXECUTE FUNCTION "billing_guard_credit_account_identity_v2"();

ALTER TABLE "billing_credit_auto_top_up_disable_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_credit_auto_top_up_disable_events" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "billing_credit_auto_top_up_disable_events" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT ON TABLE "billing_credit_auto_top_up_disable_events" TO uoa_admin;
  END IF;
END;
$$;
