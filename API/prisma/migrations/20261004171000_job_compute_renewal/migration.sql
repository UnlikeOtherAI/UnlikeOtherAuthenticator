CREATE TABLE IF NOT EXISTS billing_job_compute_renewals (
  id TEXT PRIMARY KEY,
  issue_key CHAR(64) NOT NULL UNIQUE,
  identity_key CHAR(64) NOT NULL UNIQUE,
  secret_digest CHAR(64) NOT NULL UNIQUE,
  origin_runtime_key_id TEXT NOT NULL REFERENCES billing_ledger_runtime_keys(id) ON DELETE RESTRICT,
  origin_product VARCHAR(100) NOT NULL,
  origin_source_domain VARCHAR(255) NOT NULL,
  identity_domain VARCHAR(255) NOT NULL,
  subject_id VARCHAR(256) NOT NULL,
  org_id VARCHAR(256) NOT NULL,
  team_id VARCHAR(256) NOT NULL,
  token_version INTEGER NOT NULL CHECK (token_version >= 0),
  origin_token_jti VARCHAR(256) NOT NULL,
  origin_invocation_id VARCHAR(160) NOT NULL,
  ledger_job_id VARCHAR(160) NOT NULL,
  water_job_id UUID NOT NULL,
  scope_turn_id VARCHAR(160),
  purpose VARCHAR(32) NOT NULL CHECK (purpose IN ('research_compute', 'scope_turn_compute')),
  recipient_origin VARCHAR(255) NOT NULL CHECK (recipient_origin = 'https://api.deepwater.live'),
  recipient_product VARCHAR(100) NOT NULL CHECK (recipient_product = 'deepwater'),
  ledger_audience VARCHAR(255) NOT NULL,
  original_actor_chain JSONB,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP(3) NOT NULL,
  revoked_at TIMESTAMP(3),
  CONSTRAINT billing_job_compute_expiry CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '7 days'),
  CONSTRAINT billing_job_compute_turn CHECK (
    (purpose = 'scope_turn_compute' AND scope_turn_id IS NOT NULL)
    OR (purpose = 'research_compute' AND scope_turn_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS billing_job_compute_job_idx
  ON billing_job_compute_renewals (ledger_job_id, water_job_id, revoked_at);
CREATE INDEX IF NOT EXISTS billing_job_compute_subject_idx
  ON billing_job_compute_renewals (subject_id, token_version, expires_at);
