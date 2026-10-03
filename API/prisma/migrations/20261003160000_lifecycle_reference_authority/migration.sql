SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- Row-locking SELECT under an invoker requires UPDATE RLS as well as SELECT RLS.
-- New-container creation intentionally has no existing app.org_id; its live owner
-- therefore disappeared from the old guard under uoa_app. This trigger only checks
-- reference availability, never returns identity data or widens the write's RLS.
CREATE OR REPLACE FUNCTION uoa_lifecycle_reference_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  data jsonb := to_jsonb(NEW);
  prior jsonb;
  uid text;
  identity_field text;
  oid text := COALESCE(data->>'org_id',data->>'organisation_id');
  tid text := data->>'team_id';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    prior := to_jsonb(OLD);
    -- Existing access can be removed in a frozen scope. Never admit a new
    -- inactive assignment, or move an old one to a different frozen subject.
    IF TG_TABLE_NAME IN ('org_members','team_members') AND data->>'status' <> 'ACTIVE'
      AND data->>'user_id' IS NOT DISTINCT FROM prior->>'user_id'
      AND oid IS NOT DISTINCT FROM COALESCE(prior->>'org_id',prior->>'organisation_id')
      AND tid IS NOT DISTINCT FROM prior->>'team_id' THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME = 'billing_service_accesses' AND data->>'active' = 'false'
      AND data->>'user_id' IS NOT DISTINCT FROM prior->>'user_id'
      AND tid IS NOT DISTINCT FROM prior->>'team_id' THEN RETURN NEW; END IF;
  END IF;
  FOREACH identity_field IN ARRAY ARRAY['user_id','owner_id','requested_by_user_id',
    'invited_by_user_id','created_by_user_id'] LOOP
    uid := data->>identity_field;
    IF uid IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM users WHERE id=uid AND lifecycle_status='ACTIVE' FOR SHARE) THEN
      RAISE EXCEPTION 'Identity unavailable' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF oid IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM organisations WHERE id=oid AND lifecycle_status='ACTIVE' FOR SHARE) THEN
    RAISE EXCEPTION 'Organisation unavailable' USING ERRCODE='23514';
  END IF;
  IF tid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM teams t JOIN organisations o ON o.id=t.org_id
    WHERE t.id=tid AND t.lifecycle_status='ACTIVE' AND o.lifecycle_status='ACTIVE' FOR SHARE OF t,o) THEN
    RAISE EXCEPTION 'Team unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION %I.uoa_lifecycle_reference_guard() SET search_path = %I, pg_temp', current_schema(), current_schema());
  EXECUTE format('REVOKE ALL ON FUNCTION %I.uoa_lifecycle_reference_guard() FROM PUBLIC', current_schema());
END $$;

CREATE TRIGGER lifecycle_billing_access BEFORE INSERT OR UPDATE OF user_id,team_id,active
  ON billing_service_accesses FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
CREATE TRIGGER lifecycle_groups BEFORE INSERT ON groups
  FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
CREATE TRIGGER lifecycle_group_members BEFORE INSERT OR UPDATE ON group_members
  FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
