SET lock_timeout = '5s';
SET statement_timeout = '60s';
-- AlterTable
ALTER TABLE "org_sso_policies" ADD COLUMN     "allow_unverified_contractors" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "group_mappings" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "enterprise_product_readiness" ADD COLUMN     "config_url" TEXT,
ADD COLUMN     "login_entry_url" TEXT;

-- AlterTable
ALTER TABLE "authentication_evidence" ADD COLUMN     "policy_generation" INTEGER,
ADD COLUMN     "session_deadline" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "membership_contributions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT,
    "scope_key" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "client_domain" TEXT,
    "connection_id" TEXT,
    "role" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_suppressions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_sso_link_intents" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL,
    "client_domain" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "flow_id" TEXT NOT NULL,
    "browser_hash" TEXT NOT NULL,
    "identity" JSONB NOT NULL,
    "context" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_sso_link_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_sso_relying_intents" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "client_domain" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_sso_relying_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "membership_contributions_connection_id_user_id_active_idx" ON "membership_contributions"("connection_id", "user_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "membership_contributions_org_id_user_id_scope_key_source_ki_key" ON "membership_contributions"("org_id", "user_id", "scope_key", "source_kind", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_suppressions_org_id_user_id_scope_key_key" ON "membership_suppressions"("org_id", "user_id", "scope_key");

-- CreateIndex
CREATE UNIQUE INDEX "org_sso_link_intents_flow_id_key" ON "org_sso_link_intents"("flow_id");

-- CreateIndex
CREATE INDEX "org_sso_link_intents_expires_at_idx" ON "org_sso_link_intents"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "org_sso_relying_intents_token_hash_key" ON "org_sso_relying_intents"("token_hash");

-- CreateIndex
CREATE INDEX "org_sso_relying_intents_expires_at_idx" ON "org_sso_relying_intents"("expires_at");

SET lock_timeout = '5s';
SET statement_timeout = '60s';
ALTER TABLE membership_contributions ADD CONSTRAINT contribution_scope_valid CHECK (
  (team_id IS NULL AND scope_key = 'org') OR (team_id IS NOT NULL AND scope_key = team_id)
);
ALTER TABLE membership_contributions ADD CONSTRAINT contribution_source_valid CHECK (
  source_kind IN ('manual','sso','scim') AND
  (source_kind = 'manual' OR (connection_id IS NOT NULL AND client_domain IS NOT NULL AND role IN ('member','admin'))) AND
  (source_kind = 'manual' OR team_id IS NOT NULL OR role = 'member')
);
ALTER TABLE membership_contributions ADD CONSTRAINT contribution_user_fk FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE membership_contributions ADD CONSTRAINT contribution_org_fk FOREIGN KEY(org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE membership_contributions ADD CONSTRAINT contribution_team_fk FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE;
ALTER TABLE membership_contributions ADD CONSTRAINT contribution_connection_fk FOREIGN KEY(connection_id,client_domain,org_id)
  REFERENCES org_sso_connections(id,client_domain,org_id) ON DELETE RESTRICT;
ALTER TABLE membership_suppressions ADD CONSTRAINT suppression_user_fk FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE membership_suppressions ADD CONSTRAINT suppression_org_fk FOREIGN KEY(org_id) REFERENCES organisations(id) ON DELETE CASCADE;
INSERT INTO membership_contributions(id,user_id,org_id,team_id,scope_key,source_kind,source_id,role,active,updated_at)
 SELECT 'legacy-org-'||id,user_id,org_id,NULL,'org','manual','manual',role,status='ACTIVE',now() FROM org_members;
INSERT INTO membership_contributions(id,user_id,org_id,team_id,scope_key,source_kind,source_id,role,active,updated_at)
 SELECT 'legacy-team-'||tm.id,tm.user_id,t.org_id,tm.team_id,tm.team_id,'manual','manual',tm.team_role,tm.status='ACTIVE',now()
 FROM team_members tm JOIN teams t ON t.id=tm.team_id;
INSERT INTO membership_suppressions(id,user_id,org_id,scope_key,reason)
 SELECT 'legacy-org-'||id,user_id,org_id,'org',status::text FROM org_members WHERE status <> 'ACTIVE';
INSERT INTO membership_suppressions(id,user_id,org_id,scope_key,reason)
 SELECT 'legacy-team-'||tm.id,tm.user_id,t.org_id,tm.team_id,tm.status::text
 FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE tm.status <> 'ACTIVE';

CREATE FUNCTION maintain_manual_membership_provenance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE row_org text; row_user text; row_team text; row_role text; row_status text; scope_key_value text;
BEGIN
  -- Only the trusted authority pool may identify aggregate writes as managed.
  IF current_setting('app.membership_write_source',true) = 'managed' AND
     pg_has_role(session_user,'uoa_admin','member') THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='org_members' THEN
    IF TG_OP='DELETE' THEN row_org:=OLD.org_id; row_user:=OLD.user_id; row_role:=OLD.role; row_status:='REMOVED';
    ELSE row_org:=NEW.org_id; row_user:=NEW.user_id; row_role:=NEW.role; row_status:=NEW.status::text; END IF;
    scope_key_value:='org';
  ELSE
    IF TG_OP='DELETE' THEN row_team:=OLD.team_id; row_user:=OLD.user_id; row_role:=OLD.team_role; row_status:='REMOVED';
    ELSE row_team:=NEW.team_id; row_user:=NEW.user_id; row_role:=NEW.team_role; row_status:=NEW.status::text; END IF;
    SELECT org_id INTO row_org FROM teams WHERE id=row_team;
    scope_key_value:=row_team;
  END IF;
  IF row_org IS NULL OR NOT EXISTS(SELECT 1 FROM organisations WHERE id=row_org) OR
    NOT EXISTS(SELECT 1 FROM users WHERE id=row_user) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  INSERT INTO membership_contributions(id,user_id,org_id,team_id,scope_key,source_kind,source_id,role,active,updated_at)
  VALUES('manual-'||md5(row_org||':'||row_user||':'||scope_key_value),row_user,row_org,row_team,scope_key_value,
    'manual','manual',row_role,row_status='ACTIVE',now())
  ON CONFLICT(org_id,user_id,scope_key,source_kind,source_id) DO UPDATE
    SET role=excluded.role,active=excluded.active,updated_at=now();
  IF row_status='ACTIVE' THEN
    DELETE FROM membership_suppressions WHERE org_id=row_org AND user_id=row_user AND scope_key=scope_key_value;
  ELSE
    INSERT INTO membership_suppressions(id,user_id,org_id,scope_key,reason)
    VALUES('manual-'||md5(row_org||':'||row_user||':'||scope_key_value),row_user,row_org,scope_key_value,row_status)
    ON CONFLICT(org_id,user_id,scope_key) DO UPDATE SET reason=excluded.reason;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION maintain_manual_membership_provenance() SET search_path = %I, pg_catalog, pg_temp',current_schema());
END $$;
CREATE TRIGGER org_member_manual_provenance AFTER INSERT OR UPDATE OR DELETE ON org_members
 FOR EACH ROW EXECUTE FUNCTION maintain_manual_membership_provenance();
CREATE TRIGGER team_member_manual_provenance AFTER INSERT OR UPDATE OR DELETE ON team_members
 FOR EACH ROW EXECUTE FUNCTION maintain_manual_membership_provenance();
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['membership_contributions','membership_suppressions','org_sso_link_intents','org_sso_relying_intents'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY enterprise_authority_deny_app ON %I USING(false) WITH CHECK(false)',table_name);
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='uoa_admin') THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE %I TO uoa_admin',table_name);
  END IF;
 END LOOP;
END $$;

ALTER TABLE membership_contributions ADD COLUMN resource_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE authentication_evidence ADD COLUMN amr TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE authentication_evidence ADD COLUMN acr TEXT;

ALTER TABLE org_sso_link_intents ADD CONSTRAINT link_intent_connection_fk
 FOREIGN KEY(connection_id,client_domain,org_id) REFERENCES org_sso_connections(id,client_domain,org_id) ON DELETE CASCADE;
ALTER TABLE org_sso_link_intents ADD CONSTRAINT link_intent_flow_fk
 FOREIGN KEY(flow_id) REFERENCES org_sso_flows(id) ON DELETE CASCADE;
ALTER TABLE org_sso_relying_intents ADD CONSTRAINT relying_intent_connection_fk
 FOREIGN KEY(connection_id) REFERENCES org_sso_connections(id) ON DELETE CASCADE;
CREATE OR REPLACE FUNCTION preserve_authentication_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.reference_hash,NEW.created_at,NEW.parent_id,NEW.user_id,NEW.credential_epoch,NEW.client_domain,
   NEW.method,NEW.provenance,NEW.authenticated_at,NEW.observed_at,NEW.connection_id,NEW.external_identity_id,
   NEW.connection_revision,NEW.connection_generation,NEW.policy_generation,NEW.session_deadline,NEW.amr,NEW.acr,
   NEW.org_id,NEW.team_id,NEW.purpose,NEW.action_binding,NEW.browser_hash,NEW.expires_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.reference_hash,OLD.created_at,OLD.parent_id,OLD.user_id,OLD.credential_epoch,OLD.client_domain,
   OLD.method,OLD.provenance,OLD.authenticated_at,OLD.observed_at,OLD.connection_id,OLD.external_identity_id,
   OLD.connection_revision,OLD.connection_generation,OLD.policy_generation,OLD.session_deadline,OLD.amr,OLD.acr,
   OLD.org_id,OLD.team_id,OLD.purpose,OLD.action_binding,OLD.browser_hash,OLD.expires_at)
 THEN RAISE EXCEPTION 'authentication evidence is immutable'; END IF;
 IF (OLD.mfa_completed_at IS NOT NULL AND NEW.mfa_completed_at IS DISTINCT FROM OLD.mfa_completed_at) OR
   (OLD.signature_completed_at IS NOT NULL AND NEW.signature_completed_at IS DISTINCT FROM OLD.signature_completed_at) OR
   (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) OR
   (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
 THEN RAISE EXCEPTION 'authentication evidence cannot downgrade'; END IF;
 RETURN NEW;
END $$;
CREATE UNIQUE INDEX teams_id_org_id_key ON teams(id,org_id);
ALTER TABLE membership_contributions DROP CONSTRAINT contribution_team_fk;
ALTER TABLE membership_contributions ADD CONSTRAINT contribution_team_fk
 FOREIGN KEY(team_id,org_id) REFERENCES teams(id,org_id) ON DELETE CASCADE;
