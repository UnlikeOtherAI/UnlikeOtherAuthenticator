SET lock_timeout = '5s';
SET statement_timeout = '60s';
ALTER TABLE org_sso_policies ADD COLUMN recovery_revision INTEGER NOT NULL DEFAULT 1;
CREATE TABLE enterprise_recovery_contacts (
 id TEXT PRIMARY KEY, client_domain TEXT NOT NULL, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
 policy_revision INTEGER NOT NULL, credential_epoch INTEGER NOT NULL, factor_hash TEXT NOT NULL,
 handle_hash TEXT NOT NULL UNIQUE, confirmed_at TIMESTAMP(3), last_drill_at TIMESTAMP(3), revoked_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT recovery_policy_fk FOREIGN KEY(client_domain,org_id) REFERENCES org_sso_policies(client_domain,org_id) ON DELETE RESTRICT,
 CONSTRAINT recovery_contact_shape CHECK(policy_revision>0 AND credential_epoch>=0 AND factor_hash ~ '^[0-9a-f]{64}$' AND handle_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX enterprise_recovery_contacts_client_domain_org_id_idx ON enterprise_recovery_contacts(client_domain,org_id);
CREATE TABLE enterprise_recovery_challenges (
 id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES enterprise_recovery_contacts(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, browser_hash TEXT NOT NULL, purpose TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, expires_at TIMESTAMP(3) NOT NULL, consumed_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT recovery_challenge_shape CHECK(purpose IN('confirm','drill','recover') AND attempts BETWEEN 0 AND 6)
);
CREATE INDEX enterprise_recovery_challenges_expires_at_idx ON enterprise_recovery_challenges(expires_at);
CREATE TABLE enterprise_recovery_actions (
 provenance TEXT NOT NULL DEFAULT 'sso_recovery', global_account_control BOOLEAN NOT NULL DEFAULT false,
 id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, client_domain TEXT NOT NULL, org_id TEXT NOT NULL,
 user_id TEXT NOT NULL, credential_epoch INTEGER NOT NULL, purpose TEXT NOT NULL,
 authenticated_at TIMESTAMP(3) NOT NULL, browser_hash TEXT NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT recovery_action_shape CHECK(purpose IN('confirm','drill','recover') AND provenance='sso_recovery' AND NOT global_account_control)
);
CREATE INDEX enterprise_recovery_actions_created_at_idx ON enterprise_recovery_actions(created_at);
DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['enterprise_recovery_contacts','enterprise_recovery_challenges','enterprise_recovery_actions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY recovery_deny_app ON %I USING(false) WITH CHECK(false)',tab);
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='uoa_admin') THEN EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO uoa_admin',tab); END IF;
 END LOOP;
END $$;
CREATE FUNCTION preserve_recovery_contact_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.client_domain,NEW.org_id,NEW.user_id,NEW.policy_revision,NEW.credential_epoch,NEW.factor_hash,NEW.handle_hash,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.client_domain,OLD.org_id,OLD.user_id,OLD.policy_revision,OLD.credential_epoch,OLD.factor_hash,OLD.handle_hash,OLD.created_at)
 OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
 THEN RAISE EXCEPTION 'recovery contact source is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recovery_contact_source BEFORE UPDATE ON enterprise_recovery_contacts FOR EACH ROW EXECUTE FUNCTION preserve_recovery_contact_source();
CREATE FUNCTION preserve_recovery_action_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'recovery action evidence is immutable';
END $$;
CREATE TRIGGER recovery_action_source BEFORE UPDATE ON enterprise_recovery_actions FOR EACH ROW EXECUTE FUNCTION preserve_recovery_action_source();
