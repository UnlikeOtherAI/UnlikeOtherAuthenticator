CREATE TABLE telephone_call_challenges (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  app_key_id TEXT NOT NULL, assertion_jti TEXT NOT NULL, call_id TEXT NOT NULL,
  organisation_id TEXT NOT NULL, team_id TEXT NOT NULL,
  token_version INTEGER NOT NULL CHECK (token_version >= 0),
  number VARCHAR(16) NOT NULL CHECK (number ~ '^\+[1-9][0-9]{6,14}$'),
  number_verified_at TIMESTAMP(3) NOT NULL, code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP(3) NOT NULL, used_at TIMESTAMP(3), verified_at TIMESTAMP(3)
);
CREATE UNIQUE INDEX telephone_call_challenges_app_key_id_assertion_jti_key ON telephone_call_challenges(app_key_id, assertion_jti);
CREATE INDEX telephone_call_challenges_app_key_id_call_id_created_at_idx ON telephone_call_challenges(app_key_id, call_id, created_at);
CREATE INDEX telephone_call_challenges_user_id_created_at_idx ON telephone_call_challenges(user_id, created_at);
CREATE INDEX telephone_call_challenges_number_created_at_idx ON telephone_call_challenges(number, created_at);
ALTER TABLE telephone_call_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE telephone_call_challenges FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE telephone_call_challenges FROM uoa_app;
    CREATE POLICY deny_app ON telephone_call_challenges FOR ALL TO uoa_app USING (false) WITH CHECK (false);
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE telephone_call_challenges TO uoa_admin;
  END IF;
END $$;

ALTER TABLE billing_sms_reservations ADD COLUMN telephone_call_challenge_id TEXT;
CREATE UNIQUE INDEX billing_sms_reservations_telephone_call_challenge_id_key ON billing_sms_reservations(telephone_call_challenge_id);
