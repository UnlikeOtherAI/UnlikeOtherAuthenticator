SET lock_timeout = '5s';
SET statement_timeout = '120s';
CREATE TYPE "DirectoryPermission" AS ENUM ('MEMBERSHIP_READ','DISPLAY_READ','WEBHOOK_MANAGE');
CREATE TABLE directory_credentials (
 id TEXT PRIMARY KEY, client_domain_id TEXT NOT NULL REFERENCES client_domains(id) ON DELETE RESTRICT,
 label VARCHAR(120) NOT NULL, expires_at TIMESTAMP(3) NOT NULL,
 revoked_at TIMESTAMP(3), created_at TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX directory_credentials_client_domain_id_idx ON directory_credentials(client_domain_id);
CREATE TABLE directory_credential_secrets (
 id TEXT PRIMARY KEY, credential_id TEXT NOT NULL REFERENCES directory_credentials(id) ON DELETE RESTRICT,
 digest TEXT NOT NULL UNIQUE, prefix VARCHAR(16) NOT NULL,
 expires_at TIMESTAMP(3) NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX directory_credential_secrets_credential_id_idx ON directory_credential_secrets(credential_id);
CREATE TABLE directory_organisation_grants (
 id TEXT PRIMARY KEY, credential_id TEXT NOT NULL REFERENCES directory_credentials(id) ON DELETE RESTRICT,
 org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
 permissions "DirectoryPermission"[] NOT NULL CHECK (cardinality(permissions) > 0),
 granted_by_user_id TEXT, revoked_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT now(), updated_at TIMESTAMP(3) NOT NULL DEFAULT now(),
 UNIQUE(credential_id, org_id)
);
CREATE INDEX directory_organisation_grants_org_id_idx ON directory_organisation_grants(org_id);
ALTER TABLE directory_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_credentials_deny ON directory_credentials USING(false) WITH CHECK(false);
ALTER TABLE directory_credential_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_credential_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_credential_secrets_deny ON directory_credential_secrets USING(false) WITH CHECK(false);
ALTER TABLE directory_organisation_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_organisation_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_organisation_grants_deny ON directory_organisation_grants USING(false) WITH CHECK(false);
-- No default credentials, grants, backfill from domain/billing keys, or implicit owner approval.
