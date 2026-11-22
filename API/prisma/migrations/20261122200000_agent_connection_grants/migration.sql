ALTER TYPE "ConfidentialDelegationScope" ADD VALUE IF NOT EXISTS 'agent.connection';

ALTER TABLE "organisations" ADD COLUMN "agent_connection_max_days" INTEGER;
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_agent_connection_max_days_check"
  CHECK ("agent_connection_max_days" IS NULL OR "agent_connection_max_days" BETWEEN 1 AND 3650);

CREATE TABLE "agent_connection_grants" (
    "id" TEXT NOT NULL,
    "client_domain_id" TEXT NOT NULL,
    "request_id" UUID NOT NULL,
    "connection_id" VARCHAR(160) NOT NULL,
    "source_domain" VARCHAR(255) NOT NULL,
    "subject_id" VARCHAR(256) NOT NULL,
    "org_id" VARCHAR(256) NOT NULL,
    "team_id" VARCHAR(256) NOT NULL,
    "token_version" INTEGER NOT NULL,
    "origin_token_jti" VARCHAR(256) NOT NULL,
    "product" VARCHAR(100) NOT NULL,
    "resource" VARCHAR(2048) NOT NULL,
    "binding_hash" CHAR(64) NOT NULL,
    "source_assurance_id" TEXT NOT NULL,
    "method" VARCHAR(20) NOT NULL,
    "sso_connection_id" TEXT,
    "sso_connection_revision" INTEGER,
    "sso_connection_generation" INTEGER,
    "external_identity_id" TEXT,
    "mfa_source" TEXT NOT NULL,
    "amr" TEXT[],
    "policy_generation" INTEGER NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_touched_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    CONSTRAINT "agent_connection_grants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_connection_grants_method_check" CHECK ("method" IN ('independent', 'sso'))
);

CREATE UNIQUE INDEX "agent_connection_grants_client_domain_id_request_id_key"
  ON "agent_connection_grants"("client_domain_id", "request_id");
CREATE INDEX "agent_connection_grants_subject_id_token_version_idx"
  ON "agent_connection_grants"("subject_id", "token_version");
CREATE INDEX "agent_connection_grants_org_id_team_id_idx"
  ON "agent_connection_grants"("org_id", "team_id");

ALTER TABLE "agent_connection_grants" ADD CONSTRAINT "agent_connection_grants_client_domain_id_fkey"
  FOREIGN KEY ("client_domain_id") REFERENCES "client_domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

REVOKE ALL ON TABLE agent_connection_grants FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE agent_connection_grants FROM uoa_app;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE agent_connection_grants TO uoa_admin;
  END IF;
END
$$;

ALTER TABLE agent_connection_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_connection_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_connection_grants_deny_app ON agent_connection_grants
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
