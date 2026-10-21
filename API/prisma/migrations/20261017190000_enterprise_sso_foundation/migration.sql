SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- Additive only: historical sessions have unknown provenance and are never backfilled.
-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "assurance_id" TEXT,
ADD COLUMN     "encrypted_assurance_reference" TEXT;

-- CreateTable
CREATE TABLE "org_sso_policies" (
    "client_domain" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "enforcement" TEXT NOT NULL DEFAULT 'off',
    "session_max_age_seconds" INTEGER NOT NULL DEFAULT 28800,
    "reauth_mode" TEXT NOT NULL DEFAULT 'detect_only',
    "jit_enabled" BOOLEAN NOT NULL DEFAULT false,
    "default_team_id" TEXT,
    "discovery_enabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "org_sso_policies_pkey" PRIMARY KEY ("client_domain","org_id")
);

-- CreateTable
CREATE TABLE "org_sso_connections" (
    "id" TEXT NOT NULL,
    "client_domain" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "preset" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "configuration" JSONB NOT NULL,
    "encrypted_secret" TEXT,
    "tested_revision" INTEGER,
    "last_test_code" TEXT,
    "last_test_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_sso_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_email_domains" (
    "id" TEXT NOT NULL,
    "client_domain" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "email_domain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "challenge_hash" TEXT NOT NULL,
    "challenge_expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "checked_at" TIMESTAMP(3),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organisation_email_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "client_domain" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "identity_scope" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "linked_via" TEXT NOT NULL,
    "proof_assurance_id" TEXT,
    "domain_claim_id" TEXT,
    "last_authenticated_at" TIMESTAMP(3),

    CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_assurances" (
    "id" TEXT NOT NULL,
    "reference_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_epoch" INTEGER NOT NULL,
    "client_domain" TEXT NOT NULL,
    "org_id" TEXT,
    "team_id" TEXT,
    "family_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "connection_id" TEXT,
    "connection_revision" INTEGER,
    "connection_generation" INTEGER,
    "external_identity_id" TEXT,
    "method" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "authenticated_at" TIMESTAMP(3),
    "mfa_source" TEXT NOT NULL,
    "amr" TEXT[],
    "acr" TEXT,
    "policy_generation" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "session_assurances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_sso_management_sessions" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "browser_hash" TEXT,
    "csrf_hash" TEXT,
    "user_id" TEXT NOT NULL,
    "credential_epoch" INTEGER NOT NULL,
    "assurance_id" TEXT NOT NULL,
    "client_domain" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "authenticated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "exchanged_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "org_sso_management_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_sso_flows" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "browser_hash" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "encrypted_verifier" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "management_session_id" TEXT,
    "context" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "org_sso_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_sso_replays" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_sso_replays_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "org_sso_grants" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT,
    "connection_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "org_sso_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_resource_links" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "client_domain" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "external_id" TEXT,
    "subject_binding" TEXT,
    "user_id" TEXT,
    "attributes" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_resource_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_connection_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "scim_connection_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_revocation_events" (
    "sequence" BIGSERIAL NOT NULL,
    "id" TEXT NOT NULL,
    "client_domain" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "org_id" TEXT,
    "team_id" TEXT,
    "user_id" TEXT,
    "connection_id" TEXT,
    "revision" INTEGER NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_revocation_events_pkey" PRIMARY KEY ("sequence")
);

-- CreateTable
CREATE TABLE "org_revocation_consumers" (
    "client_domain" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "encrypted_secret" TEXT NOT NULL,
    "delivered_sequence" BIGINT NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "org_revocation_consumers_pkey" PRIMARY KEY ("client_domain")
);

-- CreateTable
CREATE TABLE "enterprise_product_readiness" (
    "client_domain" TEXT NOT NULL,
    "minimum_assurance_version" INTEGER NOT NULL DEFAULT 0,
    "authority_migration_revision" TEXT,
    "revocation_consumers_revision" TEXT,
    "recovery_design_revision" TEXT,

    CONSTRAINT "enterprise_product_readiness_pkey" PRIMARY KEY ("client_domain")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_sso_connections_id_client_domain_org_id_key" ON "org_sso_connections"("id", "client_domain", "org_id");

-- CreateIndex
CREATE INDEX "organisation_email_domains_client_domain_email_domain_statu_idx" ON "organisation_email_domains"("client_domain", "email_domain", "status");

-- CreateIndex
CREATE UNIQUE INDEX "external_identities_connection_id_issuer_tenant_subject_key" ON "external_identities"("connection_id", "issuer", "tenant", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "session_assurances_reference_hash_key" ON "session_assurances"("reference_hash");

-- CreateIndex
CREATE INDEX "session_assurances_family_id_idx" ON "session_assurances"("family_id");

-- CreateIndex
CREATE INDEX "session_assurances_client_domain_org_id_user_id_idx" ON "session_assurances"("client_domain", "org_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_sso_management_sessions_token_hash_key" ON "org_sso_management_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "org_sso_management_sessions_expires_at_idx" ON "org_sso_management_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "org_sso_flows_expires_at_idx" ON "org_sso_flows"("expires_at");

-- CreateIndex
CREATE INDEX "org_sso_replays_expires_at_idx" ON "org_sso_replays"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "org_sso_grants_connection_id_resource_id_user_id_org_id_key" ON "org_sso_grants"("connection_id", "resource_id", "user_id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "scim_resource_links_connection_id_resource_type_external_id_key" ON "scim_resource_links"("connection_id", "resource_type", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "scim_connection_tokens_token_hash_key" ON "scim_connection_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "org_revocation_events_id_key" ON "org_revocation_events"("id");

-- CreateIndex
CREATE INDEX "org_revocation_events_client_domain_sequence_idx" ON "org_revocation_events"("client_domain", "sequence");

-- AddForeignKey
ALTER TABLE "org_sso_connections" ADD CONSTRAINT "org_sso_connections_client_domain_org_id_fkey" FOREIGN KEY ("client_domain", "org_id") REFERENCES "org_sso_policies"("client_domain", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_connection_id_client_domain_org_id_fkey" FOREIGN KEY ("connection_id", "client_domain", "org_id") REFERENCES "org_sso_connections"("id", "client_domain", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_resource_links" ADD CONSTRAINT "scim_resource_links_connection_id_client_domain_org_id_fkey" FOREIGN KEY ("connection_id", "client_domain", "org_id") REFERENCES "org_sso_connections"("id", "client_domain", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_connection_tokens" ADD CONSTRAINT "scim_connection_tokens_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "org_sso_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Scope is structural. An origin domain is not an organisation/product-access boundary.
ALTER TABLE org_sso_policies ADD CONSTRAINT sso_policy_client_fk FOREIGN KEY (client_domain) REFERENCES client_domains(domain) ON DELETE RESTRICT;
ALTER TABLE org_sso_policies ADD CONSTRAINT sso_policy_org_fk FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE RESTRICT;
ALTER TABLE external_identities ADD CONSTRAINT sso_identity_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE session_assurances ADD CONSTRAINT sso_assurance_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE session_assurances ADD CONSTRAINT sso_assurance_parent_fk FOREIGN KEY (parent_id) REFERENCES session_assurances(id) ON DELETE RESTRICT;
ALTER TABLE session_assurances ADD CONSTRAINT sso_assurance_identity_fk FOREIGN KEY (external_identity_id) REFERENCES external_identities(id) ON DELETE RESTRICT;
ALTER TABLE organisation_email_domains ADD CONSTRAINT sso_domain_org_fk FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE RESTRICT;
ALTER TABLE org_sso_policies ADD CONSTRAINT sso_policy_modes_check CHECK (enforcement IN ('off','required_for_verified_domains','required_for_all_members') AND reauth_mode IN ('detect_only','force') AND session_max_age_seconds BETWEEN 300 AND 86400);
ALTER TABLE org_sso_connections ADD CONSTRAINT sso_connection_state_check CHECK (status IN ('draft','testing','active','disabled','suspended') AND protocol IN ('oidc','saml') AND revision > 0 AND generation > 0);
ALTER TABLE session_assurances ADD CONSTRAINT sso_assurance_method_check CHECK (method IN ('independent','sso','recovery') AND credential_epoch >= 0 AND expires_at > observed_at AND (method <> 'sso' OR (connection_id IS NOT NULL AND external_identity_id IS NOT NULL AND org_id IS NOT NULL)));
ALTER TABLE org_sso_grants ADD CONSTRAINT sso_grant_role_check CHECK (role IN ('member','admin'));
CREATE UNIQUE INDEX organisation_email_domains_current_claim ON organisation_email_domains(client_domain,email_domain) WHERE status IN ('PENDING','VERIFIED');

-- Customer management/provisioning operates through the scoped owner/connection services using
-- the bootstrap pool. Tenant SQL cannot bypass those proof, freshness and revision checks.
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['org_sso_policies','org_sso_connections','organisation_email_domains','external_identities','session_assurances','org_sso_management_sessions','org_sso_flows','org_sso_replays','org_sso_grants','scim_resource_links','scim_connection_tokens','org_revocation_events','org_revocation_consumers','enterprise_product_readiness'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY enterprise_deny_app ON %I USING (false) WITH CHECK (false)', table_name);
  END LOOP;
END $$;
CREATE POLICY enterprise_policy_read ON org_sso_policies FOR SELECT USING (client_domain = NULLIF(current_setting('app.domain',true),'') AND org_id = NULLIF(current_setting('app.org_id',true),''));
CREATE POLICY enterprise_readiness_read ON enterprise_product_readiness FOR SELECT USING (client_domain = NULLIF(current_setting('app.domain',true),''));

-- The rollout minimum is monotonic. A later deploy/config cannot erase unknown provenance checks.
CREATE FUNCTION uoa_enterprise_assurance_minimum_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.minimum_assurance_version < OLD.minimum_assurance_version THEN
    RAISE EXCEPTION 'enterprise assurance contract cannot downgrade';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enterprise_assurance_minimum_monotonic BEFORE UPDATE ON enterprise_product_readiness
FOR EACH ROW EXECUTE FUNCTION uoa_enterprise_assurance_minimum_monotonic();
DROP POLICY enterprise_policy_read ON org_sso_policies;
-- Policy must be visible before an exact org is admitted: hiding it behind app.org_id would
-- turn the bootstrap/direct lookup into a policy bypass. No secret is held in this table.
CREATE POLICY enterprise_policy_read ON org_sso_policies FOR SELECT USING (client_domain = NULLIF(current_setting('app.domain',true),''));
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['org_sso_policies','org_sso_connections','organisation_email_domains','external_identities','session_assurances','org_sso_management_sessions','org_sso_flows','org_sso_replays','org_sso_grants','scim_resource_links','scim_connection_tokens','org_revocation_events','org_revocation_consumers','enterprise_product_readiness'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE %I TO uoa_admin', table_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT USAGE,SELECT ON SEQUENCE org_revocation_events_sequence_seq TO uoa_admin;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    GRANT SELECT ON org_sso_policies,enterprise_product_readiness TO uoa_app;
  END IF;
END $$;
