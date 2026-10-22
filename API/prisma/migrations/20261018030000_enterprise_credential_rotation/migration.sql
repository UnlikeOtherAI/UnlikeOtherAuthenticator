SET lock_timeout='5s';
SET statement_timeout='60s';
ALTER TABLE org_sso_connections ADD COLUMN activated_at TIMESTAMP(3), ADD COLUMN encrypted_next_secret TEXT,
 ADD COLUMN encrypted_previous_secret TEXT, ADD COLUMN key_overlap_expires_at TIMESTAMP(3);
UPDATE org_sso_connections SET activated_at=created_at WHERE status IN('active','disabled','suspended');
CREATE FUNCTION preserve_sso_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at
 THEN RAISE EXCEPTION 'SSO activation history is immutable'; END IF;
 IF NEW.status='active' AND NEW.activated_at IS NULL THEN NEW.activated_at:=CURRENT_TIMESTAMP; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sso_activation_history BEFORE INSERT OR UPDATE ON org_sso_connections FOR EACH ROW EXECUTE FUNCTION preserve_sso_activation();
