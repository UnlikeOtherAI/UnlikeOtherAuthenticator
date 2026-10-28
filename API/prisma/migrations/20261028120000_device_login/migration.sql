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
  approved_at timestamp(3),
  denied_at timestamp(3),
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
