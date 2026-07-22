-- Linearize every customer-triggered billing effect behind one durable,
-- append-only authorization point. Domain-specific Checkout, cancellation,
-- subscription, and credit rows remain the effect state machines.
CREATE TABLE "billing_customer_action_intents" (
  "id" TEXT NOT NULL,
  "app_key_id" TEXT NOT NULL,
  "service_id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "requested_by_user_id" TEXT NOT NULL,
  "authority_scope" "BillingAssignmentScope" NOT NULL,
  "operation" VARCHAR(100) NOT NULL,
  "actor_jti" VARCHAR(256) NOT NULL,
  "request_digest" CHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_customer_action_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_customer_action_intents_operation_check"
    CHECK (btrim("operation") <> ''),
  CONSTRAINT "billing_customer_action_intents_actor_jti_check"
    CHECK (btrim("actor_jti") <> ''),
  CONSTRAINT "billing_customer_action_intents_digest_check"
    CHECK ("request_digest" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "billing_customer_action_intents_actor_action_key"
  ON "billing_customer_action_intents"("app_key_id", "actor_jti", "operation");
CREATE INDEX "billing_customer_action_intents_service_idx"
  ON "billing_customer_action_intents"("service_id");
CREATE INDEX "billing_customer_action_intents_scope_created_idx"
  ON "billing_customer_action_intents"("org_id", "team_id", "created_at");
CREATE INDEX "billing_customer_action_intents_actor_created_idx"
  ON "billing_customer_action_intents"("requested_by_user_id", "created_at");

ALTER TABLE "billing_customer_action_intents"
  ADD CONSTRAINT "billing_customer_action_intents_app_key_id_fkey"
  FOREIGN KEY ("app_key_id") REFERENCES "billing_app_keys"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_customer_action_intents"
  ADD CONSTRAINT "billing_customer_action_intents_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "billing_services"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_customer_action_intents"
  ADD CONSTRAINT "billing_customer_action_intents_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_customer_action_intents"
  ADD CONSTRAINT "billing_customer_action_intents_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_customer_action_intents"
  ADD CONSTRAINT "billing_customer_action_intents_requested_by_user_id_fkey"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "billing_customer_action_intent_guard"() RETURNS trigger
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
         AND app_key_row."expires_at" <= CURRENT_TIMESTAMP)
     OR service_row."id" IS NULL
     OR service_row."active" IS DISTINCT FROM TRUE
     OR user_row."id" IS NULL
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

CREATE TRIGGER billing_customer_action_intents_guarded
BEFORE INSERT OR UPDATE OR DELETE ON "billing_customer_action_intents"
FOR EACH ROW EXECUTE FUNCTION "billing_customer_action_intent_guard"();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE "billing_customer_action_intents" FROM uoa_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT ON TABLE "billing_customer_action_intents" TO uoa_admin;
  END IF;
END;
$$;

ALTER TABLE "billing_customer_action_intents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_customer_action_intents" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uoa_app') THEN
    CREATE POLICY "billing_customer_action_intents_deny_app"
      ON "billing_customer_action_intents"
      FOR ALL TO uoa_app USING (false) WITH CHECK (false);
  END IF;
END;
$$;
