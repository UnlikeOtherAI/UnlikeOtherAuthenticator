SET lock_timeout = '5s';
SET statement_timeout = '60s';
CREATE TABLE org_sso_management_factor_challenges (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, browser_hash TEXT NOT NULL,
 client_domain TEXT NOT NULL REFERENCES client_domains(domain) ON DELETE CASCADE,
 org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
 user_id TEXT REFERENCES users(id) ON DELETE CASCADE, credential_epoch INTEGER, factor_hash TEXT,
 config_url TEXT NOT NULL, config_fingerprint TEXT NOT NULL, context JSONB NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, expires_at TIMESTAMP(3) NOT NULL,
 consumed_at TIMESTAMP(3), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT management_factor_bounds CHECK(attempts BETWEEN 0 AND 6 AND
  ((user_id IS NULL AND credential_epoch IS NULL AND factor_hash IS NULL) OR
   (user_id IS NOT NULL AND credential_epoch >= 0 AND factor_hash IS NOT NULL)))
);
CREATE INDEX management_factor_expiry ON org_sso_management_factor_challenges(expires_at);
ALTER TABLE org_sso_management_factor_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_sso_management_factor_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY management_factor_deny_app ON org_sso_management_factor_challenges USING(false) WITH CHECK(false);
DO $$ BEGIN IF EXISTS(SELECT FROM pg_roles WHERE rolname='uoa_admin') THEN
 GRANT SELECT,INSERT,UPDATE,DELETE ON org_sso_management_factor_challenges TO uoa_admin;
END IF; END $$;
CREATE FUNCTION preserve_management_factor_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.token_hash,NEW.browser_hash,NEW.client_domain,NEW.org_id,NEW.user_id,NEW.credential_epoch,
  NEW.factor_hash,NEW.config_url,NEW.config_fingerprint,NEW.context,NEW.expires_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.token_hash,OLD.browser_hash,OLD.client_domain,OLD.org_id,OLD.user_id,OLD.credential_epoch,
  OLD.factor_hash,OLD.config_url,OLD.config_fingerprint,OLD.context,OLD.expires_at)
 THEN RAISE EXCEPTION 'management factor binding is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER management_factor_binding_immutable BEFORE UPDATE ON org_sso_management_factor_challenges
 FOR EACH ROW EXECUTE FUNCTION preserve_management_factor_binding();
