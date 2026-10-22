-- An organisation may be used by a product on a different source domain.
-- Preserve same-domain delivery, and include only unambiguous active product
-- mappings with direct access evidence for this exact organisation/team.
CREATE OR REPLACE FUNCTION enqueue_directory_person() RETURNS trigger
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
  INSERT INTO directory_webhook_events (domain,org_id,team_id,subject)
    WITH affected AS (
      SELECT DISTINCT o.domain,t.org_id,t.id FROM teams t JOIN organisations o ON o.id=t.org_id
      WHERE (affected_team IS NOT NULL AND t.id=affected_team)
        OR (affected_team IS NULL AND (affected_org IS NULL OR t.org_id=affected_org)
          AND EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=affected_subject))
    ), product_keys AS (
      SELECT d.domain, min(k.service_id) AS service_id FROM client_domains d
      JOIN billing_app_keys k ON k.actor_issuer='https://' || d.domain
      JOIN billing_services s ON s.id=k.service_id
      WHERE d.status='active' AND k.purpose='CUSTOMER_LIFECYCLE' AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at>now()) AND s.active
      GROUP BY d.domain HAVING count(DISTINCT k.service_id)=1
    )
    SELECT a.domain,a.org_id,a.id,affected_subject FROM affected a
    UNION
    SELECT p.domain,a.org_id,a.id,affected_subject FROM affected a JOIN product_keys p ON true
    WHERE EXISTS (SELECT 1 FROM billing_service_accesses x WHERE x.service_id=p.service_id
      AND x.org_id=a.org_id AND x.team_id=a.id AND x.active AND x.revoked_at IS NULL);
  RETURN COALESCE(NEW, OLD);
END $$;
REVOKE ALL ON FUNCTION enqueue_directory_person() FROM PUBLIC;
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION %I.enqueue_directory_person() SET search_path TO %I, pg_temp',
    current_schema(), current_schema());
END $$;
