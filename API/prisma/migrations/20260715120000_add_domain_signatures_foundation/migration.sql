-- Optional per-domain agreement signature module foundation.
-- All tables are admin/auth-flow owned in Phase 1 and are deny-all to uoa_app.

CREATE TYPE "SignatureMethod" AS ENUM ('CLICKWRAP', 'TYPED_NAME');
CREATE TYPE "AgreementVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'WITHDRAWN');
CREATE TYPE "SignatureAuthProfile" AS ENUM ('CONFIG_JWT', 'PUBLIC_OAUTH');

CREATE TABLE "domain_signature_settings" (
    "domain" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "policy_revision" INTEGER NOT NULL DEFAULT 0,
    "retention_days" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domain_signature_settings_pkey" PRIMARY KEY ("domain")
);

CREATE TABLE "agreements" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(1000),
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "required_for_access" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agreements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agreement_versions" (
    "id" TEXT NOT NULL,
    "agreement_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "original_filename" VARCHAR(255) NOT NULL,
    "source_storage_key" TEXT NOT NULL,
    "source_pdf_sha256" VARCHAR(64) NOT NULL,
    "signing_method" "SignatureMethod" NOT NULL,
    "acceptance_statement" TEXT NOT NULL,
    "status" "AgreementVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMP(3),
    "effective_at" TIMESTAMP(3),
    "published_by_email" CITEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agreement_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "signing_continuations" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "auth_profile" "SignatureAuthProfile" NOT NULL,
    "config_url" VARCHAR(2048),
    "redirect_url" VARCHAR(2048) NOT NULL,
    "oauth_state" VARCHAR(1024),
    "oauth_client_id" VARCHAR(200),
    "resource" VARCHAR(2048),
    "code_challenge" VARCHAR(128) NOT NULL,
    "code_challenge_method" VARCHAR(16) NOT NULL,
    "remember_me" BOOLEAN NOT NULL DEFAULT false,
    "org_id" TEXT,
    "team_id" TEXT,
    "auth_method" VARCHAR(32) NOT NULL,
    "two_fa_completed" BOOLEAN NOT NULL DEFAULT false,
    "policy_revision" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signing_continuations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agreement_signatures" (
    "id" TEXT NOT NULL,
    "verification_reference" VARCHAR(64) NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_email" CITEXT NOT NULL,
    "signer_name" VARCHAR(200) NOT NULL,
    "domain" TEXT NOT NULL,
    "agreement_version_id" TEXT NOT NULL,
    "signing_continuation_id" TEXT NOT NULL,
    "signing_method" "SignatureMethod" NOT NULL,
    "typed_name" VARCHAR(200),
    "acceptance_statement" TEXT NOT NULL,
    "source_pdf_sha256" VARCHAR(64) NOT NULL,
    "auth_method" VARCHAR(32) NOT NULL,
    "two_fa_completed" BOOLEAN NOT NULL,
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(1000),
    "evidence_manifest_sha256" VARCHAR(64) NOT NULL,
    "receipt_pdf_sha256" VARCHAR(64) NOT NULL,
    "receipt_storage_key" TEXT NOT NULL,
    "evidence_key_id" VARCHAR(200) NOT NULL,
    "evidence_signature" TEXT NOT NULL,
    "signed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agreement_signatures_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "signature_revocations" (
    "id" TEXT NOT NULL,
    "signature_id" TEXT NOT NULL,
    "actor_email" CITEXT NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "revoked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_revocations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "signature_audit_events" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_email" CITEXT,
    "action" VARCHAR(100) NOT NULL,
    "target_type" VARCHAR(50) NOT NULL,
    "target_id" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agreements_domain_display_order_idx" ON "agreements"("domain", "display_order");
CREATE UNIQUE INDEX "agreement_versions_agreement_id_version_key" ON "agreement_versions"("agreement_id", "version");
CREATE INDEX "agreement_versions_agreement_id_status_effective_at_idx" ON "agreement_versions"("agreement_id", "status", "effective_at");
CREATE INDEX "agreement_versions_source_pdf_sha256_idx" ON "agreement_versions"("source_pdf_sha256");
CREATE UNIQUE INDEX "signing_continuations_token_hash_key" ON "signing_continuations"("token_hash");
CREATE INDEX "signing_continuations_user_id_domain_idx" ON "signing_continuations"("user_id", "domain");
CREATE INDEX "signing_continuations_expires_at_idx" ON "signing_continuations"("expires_at");
CREATE UNIQUE INDEX "agreement_signatures_verification_reference_key" ON "agreement_signatures"("verification_reference");
CREATE INDEX "agreement_signatures_user_id_domain_agreement_version_id_idx" ON "agreement_signatures"("user_id", "domain", "agreement_version_id");
CREATE INDEX "agreement_signatures_domain_signed_at_idx" ON "agreement_signatures"("domain", "signed_at");
CREATE UNIQUE INDEX "signature_revocations_signature_id_key" ON "signature_revocations"("signature_id");
CREATE INDEX "signature_revocations_revoked_at_idx" ON "signature_revocations"("revoked_at");
CREATE INDEX "signature_audit_events_domain_created_at_idx" ON "signature_audit_events"("domain", "created_at");
CREATE INDEX "signature_audit_events_target_type_target_id_idx" ON "signature_audit_events"("target_type", "target_id");

ALTER TABLE "domain_signature_settings" ADD CONSTRAINT "domain_signature_settings_domain_fkey"
  FOREIGN KEY ("domain") REFERENCES "client_domains"("domain") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_domain_fkey"
  FOREIGN KEY ("domain") REFERENCES "domain_signature_settings"("domain") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agreement_versions" ADD CONSTRAINT "agreement_versions_agreement_id_fkey"
  FOREIGN KEY ("agreement_id") REFERENCES "agreements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "signing_continuations" ADD CONSTRAINT "signing_continuations_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signing_continuations" ADD CONSTRAINT "signing_continuations_domain_fkey"
  FOREIGN KEY ("domain") REFERENCES "client_domains"("domain") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agreement_signatures" ADD CONSTRAINT "agreement_signatures_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agreement_signatures" ADD CONSTRAINT "agreement_signatures_domain_fkey"
  FOREIGN KEY ("domain") REFERENCES "client_domains"("domain") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agreement_signatures" ADD CONSTRAINT "agreement_signatures_agreement_version_id_fkey"
  FOREIGN KEY ("agreement_version_id") REFERENCES "agreement_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agreement_signatures" ADD CONSTRAINT "agreement_signatures_signing_continuation_id_fkey"
  FOREIGN KEY ("signing_continuation_id") REFERENCES "signing_continuations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "signature_revocations" ADD CONSTRAINT "signature_revocations_signature_id_fkey"
  FOREIGN KEY ("signature_id") REFERENCES "agreement_signatures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE
      "domain_signature_settings", "agreements", "agreement_versions",
      "signing_continuations", "agreement_signatures", "signature_revocations",
      "signature_audit_events"
    FROM "uoa_app";
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      "domain_signature_settings", "agreements", "agreement_versions",
      "signing_continuations", "agreement_signatures", "signature_revocations",
      "signature_audit_events"
    TO "uoa_admin";
  END IF;
END
$$;

ALTER TABLE "domain_signature_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "domain_signature_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY domain_signature_settings_deny_app ON "domain_signature_settings"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);

ALTER TABLE "agreements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agreements" FORCE ROW LEVEL SECURITY;
CREATE POLICY agreements_deny_app ON "agreements"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);

ALTER TABLE "agreement_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agreement_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY agreement_versions_deny_app ON "agreement_versions"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);

ALTER TABLE "signing_continuations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signing_continuations" FORCE ROW LEVEL SECURITY;
CREATE POLICY signing_continuations_deny_app ON "signing_continuations"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);

ALTER TABLE "agreement_signatures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agreement_signatures" FORCE ROW LEVEL SECURITY;
CREATE POLICY agreement_signatures_deny_app ON "agreement_signatures"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);

ALTER TABLE "signature_revocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signature_revocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY signature_revocations_deny_app ON "signature_revocations"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);

ALTER TABLE "signature_audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signature_audit_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY signature_audit_events_deny_app ON "signature_audit_events"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
