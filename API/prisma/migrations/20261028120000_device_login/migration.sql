BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE client_domains ADD COLUMN device_login_config_urls text[] NOT NULL DEFAULT ARRAY[]::text[];
CREATE TABLE device_login_grants (
  id text PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  source_family_id text NOT NULL,
  user_id text NOT NULL,
  token_version integer NOT NULL,
  domain text NOT NULL,
  client_id text NOT NULL,
  config_url text NOT NULL,
  org_id text,
  team_id text,
  claim_id text UNIQUE,
  challenge text,
  confirmation_code text,
  claim_expires_at timestamp(3),
  approved_at timestamp(3),
  used_at timestamp(3),
  expires_at timestamp(3) NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX device_login_grants_user_id_created_at_idx ON device_login_grants(user_id, created_at);
CREATE INDEX device_login_grants_expires_at_idx ON device_login_grants(expires_at);
CREATE TABLE device_login_attempt_buckets (
  key_hash text PRIMARY KEY,
  count integer NOT NULL,
  reset_at timestamp(3) NOT NULL
);
CREATE INDEX device_login_attempt_buckets_reset_at_idx ON device_login_attempt_buckets(reset_at);

-- These pre-tenant authentication capabilities are accessed only through uoa_admin.
-- Future-table default grants must not expose them to the ordinary tenant role.
ALTER TABLE device_login_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_login_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE device_login_attempt_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_login_attempt_buckets FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE device_login_grants, device_login_attempt_buckets FROM uoa_app;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE device_login_grants, device_login_attempt_buckets TO uoa_admin;
  END IF;
END $$;
COMMIT;
