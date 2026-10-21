-- Verified contact data belongs to UOA. No legacy phone is backfilled.
CREATE TABLE user_telephones (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  number VARCHAR(16) CHECK (number ~ '^\+[1-9][0-9]{6,14}$'),
  pending_number VARCHAR(16) CHECK (pending_number ~ '^\+[1-9][0-9]{6,14}$'),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team')),
  verified_at TIMESTAMP(3),
  CHECK ((number IS NULL) = (verified_at IS NULL))
);
CREATE INDEX user_telephones_number_idx ON user_telephones(number);
CREATE INDEX user_telephones_pending_number_idx ON user_telephones(pending_number);
CREATE TABLE telephone_challenges (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  app_key_id TEXT NOT NULL, token_version INTEGER NOT NULL CHECK (token_version >= 0),
  number VARCHAR(16) NOT NULL CHECK (number ~ '^\+[1-9][0-9]{6,14}$'),
  code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP(3) NOT NULL, used_at TIMESTAMP(3)
);
CREATE INDEX telephone_challenges_user_id_created_at_idx ON telephone_challenges(user_id, created_at);
CREATE INDEX telephone_challenges_number_created_at_idx ON telephone_challenges(number, created_at);
CREATE TABLE telephone_lookups (
  app_key_id TEXT NOT NULL, call_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  matched BOOLEAN NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(app_key_id, call_id)
);
CREATE INDEX telephone_lookups_app_key_id_created_at_idx ON telephone_lookups(app_key_id, created_at);
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['user_telephones', 'telephone_challenges', 'telephone_lookups'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM uoa_app', t);
      EXECUTE format('CREATE POLICY deny_app ON %I FOR ALL TO uoa_app USING (false) WITH CHECK (false)', t);
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO uoa_admin', t);
    END IF;
  END LOOP;
END $$;
