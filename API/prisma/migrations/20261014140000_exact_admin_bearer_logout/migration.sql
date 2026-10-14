SET lock_timeout = '5s';
SET statement_timeout = '120s';
CREATE TABLE admin_access_token_revocations (
 token_hash TEXT PRIMARY KEY, expires_at TIMESTAMP(3) NOT NULL
);
CREATE INDEX admin_access_token_revocations_expires_at_idx ON admin_access_token_revocations(expires_at);
ALTER TABLE admin_access_token_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_access_token_revocations FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_access_token_revocations_deny ON admin_access_token_revocations USING(false) WITH CHECK(false);
