SET lock_timeout = '5s';
SET statement_timeout = '60s';
-- AlterTable
ALTER TABLE "authorization_codes" ADD COLUMN     "authentication_evidence_id" TEXT;

-- AlterTable
ALTER TABLE "signing_continuations" ADD COLUMN     "authentication_evidence_id" TEXT;

-- AlterTable
ALTER TABLE "org_sso_policies" ADD COLUMN     "arrangement_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "org_sso_management_sessions" ADD COLUMN     "authentication_evidence_id" TEXT,
ADD COLUMN     "initiating_browser_hash" TEXT,
ALTER COLUMN "assurance_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "authentication_evidence" (
    "id" TEXT NOT NULL,
    "parent_id" TEXT,
    "reference_hash" CHAR(64) NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_epoch" INTEGER NOT NULL,
    "client_domain" TEXT NOT NULL,
    "method" VARCHAR(32) NOT NULL,
    "provenance" VARCHAR(32) NOT NULL,
    "authenticated_at" TIMESTAMP(3),
    "observed_at" TIMESTAMP(3) NOT NULL,
    "connection_id" TEXT,
    "external_identity_id" TEXT,
    "connection_revision" INTEGER,
    "connection_generation" INTEGER,
    "org_id" TEXT,
    "team_id" TEXT,
    "purpose" VARCHAR(32) NOT NULL,
    "action_binding" TEXT NOT NULL,
    "browser_hash" CHAR(64),
    "mfa_completed_at" TIMESTAMP(3),
    "signature_completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authentication_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_sso_management_intents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_epoch" INTEGER NOT NULL,
    "client_domain" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "authentication_evidence_id" TEXT NOT NULL,
    "browser_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_sso_management_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "authentication_evidence_reference_hash_key" ON "authentication_evidence"("reference_hash");

-- CreateIndex
CREATE INDEX "authentication_evidence_user_id_expires_at_idx" ON "authentication_evidence"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "authentication_evidence_expires_at_idx" ON "authentication_evidence"("expires_at");

-- CreateIndex
CREATE INDEX "org_sso_management_intents_expires_at_idx" ON "org_sso_management_intents"("expires_at");


ALTER TABLE authentication_evidence ADD CONSTRAINT authentication_evidence_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE authentication_evidence ADD CONSTRAINT authentication_evidence_parent_fk
  FOREIGN KEY (parent_id) REFERENCES authentication_evidence(id) ON DELETE CASCADE;
ALTER TABLE authentication_evidence ADD CONSTRAINT authentication_evidence_valid CHECK (
  credential_epoch >= 0 AND expires_at > observed_at AND
  provenance IN ('independent','sso','sso_recovery') AND purpose IN ('authorize','management','recovery') AND
  (provenance = 'independent' OR (connection_id IS NOT NULL AND external_identity_id IS NOT NULL AND org_id IS NOT NULL))
);
ALTER TABLE org_sso_management_intents ADD CONSTRAINT management_intent_evidence_fk
  FOREIGN KEY (authentication_evidence_id) REFERENCES authentication_evidence(id) ON DELETE CASCADE;
ALTER TABLE org_sso_management_sessions ADD CONSTRAINT management_session_evidence_fk
  FOREIGN KEY (authentication_evidence_id) REFERENCES authentication_evidence(id) ON DELETE CASCADE;
ALTER TABLE org_sso_management_sessions ADD CONSTRAINT management_session_one_source CHECK (
  (assurance_id IS NOT NULL)::integer + (authentication_evidence_id IS NOT NULL)::integer = 1
);
ALTER TABLE authorization_codes ADD CONSTRAINT authorization_code_evidence_fk
  FOREIGN KEY (authentication_evidence_id) REFERENCES authentication_evidence(id) ON DELETE SET NULL;
ALTER TABLE signing_continuations ADD CONSTRAINT signing_continuation_evidence_fk
  FOREIGN KEY (authentication_evidence_id) REFERENCES authentication_evidence(id) ON DELETE SET NULL;
ALTER TABLE authentication_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE authentication_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY authentication_evidence_deny_app ON authentication_evidence USING (false) WITH CHECK (false);
ALTER TABLE org_sso_management_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_sso_management_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY management_intent_deny_app ON org_sso_management_intents USING (false) WITH CHECK (false);
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE authentication_evidence, org_sso_management_intents TO uoa_admin;
  END IF;
END $$;
CREATE FUNCTION preserve_authentication_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.parent_id,NEW.user_id,NEW.credential_epoch,NEW.client_domain,NEW.method,NEW.provenance,
    NEW.authenticated_at,NEW.observed_at,NEW.connection_id,NEW.external_identity_id,NEW.connection_revision,
    NEW.connection_generation,NEW.org_id,NEW.team_id,NEW.purpose,NEW.action_binding,NEW.browser_hash,NEW.expires_at)
  IS DISTINCT FROM ROW(OLD.parent_id,OLD.user_id,OLD.credential_epoch,OLD.client_domain,OLD.method,OLD.provenance,
    OLD.authenticated_at,OLD.observed_at,OLD.connection_id,OLD.external_identity_id,OLD.connection_revision,
    OLD.connection_generation,OLD.org_id,OLD.team_id,OLD.purpose,OLD.action_binding,OLD.browser_hash,OLD.expires_at)
  THEN RAISE EXCEPTION 'authentication evidence is immutable'; END IF;
  IF (OLD.mfa_completed_at IS NOT NULL AND NEW.mfa_completed_at IS DISTINCT FROM OLD.mfa_completed_at) OR
    (OLD.signature_completed_at IS NOT NULL AND NEW.signature_completed_at IS DISTINCT FROM OLD.signature_completed_at) OR
    (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) OR
    (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
  THEN RAISE EXCEPTION 'authentication evidence cannot downgrade'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authentication_evidence_immutable BEFORE UPDATE ON authentication_evidence
  FOR EACH ROW EXECUTE FUNCTION preserve_authentication_evidence();
