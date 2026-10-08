CREATE TABLE sales_research_job_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_domain_id TEXT NOT NULL REFERENCES client_domains(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  job_id VARCHAR(160) NOT NULL,
  source_domain VARCHAR(255) NOT NULL,
  subject_id VARCHAR(256) NOT NULL,
  org_id VARCHAR(256) NOT NULL,
  team_id VARCHAR(256) NOT NULL,
  token_version INTEGER NOT NULL CHECK (token_version >= 0),
  origin_token_jti VARCHAR(256) NOT NULL,
  product VARCHAR(100) NOT NULL CHECK (product = 'salesnerd'),
  resource VARCHAR(255) NOT NULL CHECK (resource = 'https://ledger.unlikeotherai.com'),
  purpose VARCHAR(64) NOT NULL CHECK (purpose = 'research_job'),
  binding_hash CHAR(64) NOT NULL,
  authorized_until TIMESTAMPTZ(3) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ(3),
  CONSTRAINT sales_research_job_grant_expiry
    CHECK (authorized_until > created_at AND authorized_until <= created_at + INTERVAL '7 days'),
  CONSTRAINT sales_research_job_grants_request_key
    UNIQUE (client_domain_id, product, request_id),
  CONSTRAINT sales_research_job_grants_job_key
    UNIQUE (client_domain_id, product, job_id, purpose)
);

CREATE INDEX sales_research_job_grants_subject_epoch_idx
  ON sales_research_job_grants (subject_id, token_version, authorized_until);

REVOKE ALL ON TABLE sales_research_job_grants FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE sales_research_job_grants FROM uoa_app;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sales_research_job_grants TO uoa_admin;
  END IF;
END
$$;

ALTER TABLE sales_research_job_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_research_job_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_research_job_grants_deny_app ON sales_research_job_grants
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
