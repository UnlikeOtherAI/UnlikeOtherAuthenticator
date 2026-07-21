-- Keep abandoned/expired Setup Checkouts terminal, recheck their consent
-- predecessor whenever they are made actionable, and serialize disable
-- authority with concurrent app-key and membership revocation.
CREATE OR REPLACE FUNCTION "billing_credit_setup_predecessor_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_row "billing_credit_accounts"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."status" IN ('COMPLETE', 'EXPIRED', 'ABANDONED')
     AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'terminal automatic top-up setup cannot be reopened'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT'
     OR (
       TG_OP = 'UPDATE'
       AND (
         NEW."status" IN ('CREATING', 'OPEN', 'NEEDS_REVIEW')
         OR (OLD."status" <> 'COMPLETE' AND NEW."status" = 'COMPLETE')
       )
     ) THEN
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
     OR team_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR org_member_row."status" IS DISTINCT FROM 'ACTIVE'
     OR team_member_row."status" IS DISTINCT FROM 'ACTIVE'
     OR NOT (
       org_member_row."role" IN ('owner', 'admin')
       OR team_member_row."team_role" IN ('owner', 'admin')
       OR organisation_row."owner_id" = NEW."requested_by_user_id"
     ) THEN
    RAISE EXCEPTION 'automatic top-up disable event lacks current exact authority'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
