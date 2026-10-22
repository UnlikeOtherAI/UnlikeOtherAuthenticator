-- Directory notifications contain references only. The source mutation and its
-- delivery obligation commit together, including edits outside the HTTP API.
CREATE TABLE directory_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL,
  org_id text NOT NULL,
  team_id text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX directory_webhook_due ON directory_webhook_events (next_attempt_at, created_at)
  WHERE delivered_at IS NULL;
ALTER TABLE directory_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_webhook_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON directory_webhook_events FROM uoa_app;
GRANT SELECT, INSERT, UPDATE ON directory_webhook_events TO uoa_admin;
CREATE POLICY directory_webhook_deny_app ON directory_webhook_events TO uoa_app USING (false) WITH CHECK (false);

CREATE FUNCTION enqueue_directory_person() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE affected_subject text; affected_team text; affected_org text;
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    IF TG_OP = 'UPDATE' AND NEW.name IS NOT DISTINCT FROM OLD.name
      AND NEW.email IS NOT DISTINCT FROM OLD.email
      AND NEW.avatar_url IS NOT DISTINCT FROM OLD.avatar_url
      AND NEW.lifecycle_status IS NOT DISTINCT FROM OLD.lifecycle_status THEN RETURN NEW; END IF;
    affected_subject := COALESCE(NEW.id, OLD.id);
  ELSIF TG_TABLE_NAME = 'user_avatars' THEN
    affected_subject := COALESCE(NEW.user_id, OLD.user_id);
  ELSIF TG_TABLE_NAME = 'team_members' THEN
    affected_subject := COALESCE(NEW.user_id, OLD.user_id);
    affected_team := COALESCE(NEW.team_id, OLD.team_id);
  ELSE
    affected_subject := COALESCE(NEW.user_id, OLD.user_id);
    affected_org := COALESCE(NEW.org_id, OLD.org_id);
  END IF;
  IF affected_team IS NOT NULL THEN
    INSERT INTO directory_webhook_events (domain,org_id,team_id,subject)
      SELECT o.domain,t.org_id,t.id,affected_subject FROM teams t
      JOIN organisations o ON o.id=t.org_id WHERE t.id=affected_team;
  ELSE
    INSERT INTO directory_webhook_events (domain,org_id,team_id,subject)
      SELECT DISTINCT o.domain,t.org_id,t.id,affected_subject FROM team_members m
      JOIN teams t ON t.id=m.team_id JOIN organisations o ON o.id=t.org_id
      WHERE m.user_id=affected_subject AND (affected_org IS NULL OR t.org_id=affected_org);
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
REVOKE ALL ON FUNCTION enqueue_directory_person() FROM PUBLIC;
CREATE TRIGGER directory_person_profile AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION enqueue_directory_person();
CREATE TRIGGER directory_person_avatar AFTER INSERT OR UPDATE OR DELETE ON user_avatars FOR EACH ROW EXECUTE FUNCTION enqueue_directory_person();
CREATE TRIGGER directory_person_team AFTER INSERT OR UPDATE OR DELETE ON team_members FOR EACH ROW EXECUTE FUNCTION enqueue_directory_person();
CREATE TRIGGER directory_person_org AFTER INSERT OR UPDATE OR DELETE ON org_members FOR EACH ROW EXECUTE FUNCTION enqueue_directory_person();
