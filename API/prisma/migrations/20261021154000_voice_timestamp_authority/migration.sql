CREATE OR REPLACE FUNCTION "billing_customer_action_intent_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  app_key_row "billing_app_keys"%ROWTYPE;
  service_row "billing_services"%ROWTYPE;
  user_row "users"%ROWTYPE;
  organisation_row "organisations"%ROWTYPE;
  team_row "teams"%ROWTYPE;
  org_member_row "org_members"%ROWTYPE;
  team_member_row "team_members"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'customer billing action intents are append-only'
      USING ERRCODE = '23514';
  END IF;

  -- This deterministic lock order is the linearization point against app-key
  -- revocation and exact actor/workspace membership or role changes.
  SELECT * INTO app_key_row
  FROM "billing_app_keys"
  WHERE "id" = NEW."app_key_id"
  FOR UPDATE;
  SELECT * INTO service_row
  FROM "billing_services"
  WHERE "id" = NEW."service_id"
  FOR UPDATE;
  SELECT * INTO user_row
  FROM "users"
  WHERE "id" = NEW."requested_by_user_id"
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

  IF app_key_row."id" IS NULL
     OR app_key_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR app_key_row."purpose" IS DISTINCT FROM 'CUSTOMER_LIFECYCLE'
     OR app_key_row."revoked_at" IS NOT NULL
     OR (app_key_row."expires_at" IS NOT NULL
         AND app_key_row."expires_at" <= (clock_timestamp() AT TIME ZONE 'UTC'))
     OR service_row."id" IS NULL
     OR service_row."active" IS DISTINCT FROM TRUE
     OR user_row."id" IS NULL
     OR user_row."token_version" IS DISTINCT FROM NEW."actor_token_version"
     OR NEW."actor_expires_at" <= (clock_timestamp() AT TIME ZONE 'UTC')
     OR organisation_row."id" IS NULL
     OR team_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR org_member_row."status" IS DISTINCT FROM 'ACTIVE'
     OR team_member_row."status" IS DISTINCT FROM 'ACTIVE'
     OR NOT (
       organisation_row."owner_id" = NEW."requested_by_user_id"
       OR org_member_row."role" IN ('owner', 'admin')
       OR (
         NEW."authority_scope" = 'TEAM'
         AND team_member_row."team_role" IN ('owner', 'admin')
       )
     ) THEN
    RAISE EXCEPTION 'customer billing action intent lacks current exact authority'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


ALTER TABLE billing_voice_grants ALTER COLUMN created_at SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
ALTER TABLE billing_voice_quotes ALTER COLUMN created_at SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
ALTER TABLE billing_voice_reservations ALTER COLUMN created_at SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
