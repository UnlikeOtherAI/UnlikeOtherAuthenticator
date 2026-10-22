SET lock_timeout = '5s';
SET statement_timeout = '60s';
-- AlterTable
ALTER TABLE "external_identities" ADD COLUMN     "proof_authentication_evidence_id" TEXT;

-- CreateTable
CREATE TABLE "org_sso_personal_factor_challenges" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "link_intent_id" TEXT NOT NULL,
    "browser_hash" TEXT NOT NULL,
    "user_id" TEXT,
    "credential_epoch" INTEGER,
    "authentication_evidence_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_sso_personal_factor_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_sso_personal_factor_challenges_token_hash_key" ON "org_sso_personal_factor_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "org_sso_personal_factor_challenges_expires_at_idx" ON "org_sso_personal_factor_challenges"("expires_at");

ALTER TABLE external_identities ADD CONSTRAINT external_link_proof_fk
 FOREIGN KEY(proof_authentication_evidence_id) REFERENCES authentication_evidence(id) ON DELETE SET NULL;
ALTER TABLE org_sso_personal_factor_challenges ADD CONSTRAINT personal_factor_link_fk
 FOREIGN KEY(link_intent_id) REFERENCES org_sso_link_intents(id) ON DELETE CASCADE;
ALTER TABLE org_sso_personal_factor_challenges ADD CONSTRAINT personal_factor_user_fk
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE org_sso_personal_factor_challenges ADD CONSTRAINT personal_factor_evidence_fk
 FOREIGN KEY(authentication_evidence_id) REFERENCES authentication_evidence(id) ON DELETE CASCADE;
ALTER TABLE org_sso_personal_factor_challenges ADD CONSTRAINT personal_factor_bounds
 CHECK(attempts BETWEEN 0 AND 6 AND (user_id IS NULL) = (credential_epoch IS NULL));
ALTER TABLE org_sso_personal_factor_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_sso_personal_factor_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_factor_deny_app ON org_sso_personal_factor_challenges USING(false) WITH CHECK(false);
DO $$ BEGIN IF EXISTS(SELECT FROM pg_roles WHERE rolname='uoa_admin') THEN
 GRANT SELECT,INSERT,UPDATE,DELETE ON org_sso_personal_factor_challenges TO uoa_admin;
END IF; END $$;
CREATE FUNCTION preserve_external_identity_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.user_id,NEW.connection_id,NEW.client_domain,NEW.org_id,NEW.issuer,NEW.tenant,NEW.subject,NEW.identity_scope,NEW.linked_via)
 IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.connection_id,OLD.client_domain,OLD.org_id,OLD.issuer,OLD.tenant,OLD.subject,OLD.identity_scope,OLD.linked_via)
 THEN RAISE EXCEPTION 'external identity binding is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER external_identity_binding_immutable BEFORE UPDATE ON external_identities
 FOR EACH ROW EXECUTE FUNCTION preserve_external_identity_binding();
