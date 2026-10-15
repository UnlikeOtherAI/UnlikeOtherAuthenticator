BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
-- Fence supported writers before taking the DDL lock. The trigger also protects
-- older writers after commit, so a rolling deployment cannot recreate the race.
SELECT pg_advisory_xact_lock(hashtextextended('uoa:product-team-policy:v1', 0));

CREATE FUNCTION uoa_group_membership_admission(p_org_id text, p_user_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
 caller_role text := COALESCE(NULLIF(current_setting('role', true), 'none'), session_user);
 privileged boolean;
 org_domain text;
BEGIN
 SELECT domain INTO org_domain FROM organisations WHERE id=p_org_id;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT COALESCE(rolsuper OR rolbypassrls, false) INTO privileged FROM pg_roles WHERE rolname=caller_role;
 IF NOT COALESCE(privileged, false) AND NOT COALESCE((
   p_org_id=COALESCE(NULLIF(current_setting('app.org_id', true), ''), '') OR
   (current_setting('app.domain_backend', true)='on' AND
    org_domain=NULLIF(current_setting('app.domain', true), ''))
 ), false) THEN RETURN false; END IF;
 -- Narrow cross-origin identity lookup: return only admission, never profile
 -- data. SHARE conflicts with lifecycle/status updates and rechecks after wait.
 PERFORM id FROM users WHERE id=p_user_id AND lifecycle_status NOT IN ('DELETING','DELETED') FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM id FROM organisations WHERE id=p_org_id AND lifecycle_status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM id FROM org_members WHERE org_id=p_org_id AND user_id=p_user_id AND status<>'REMOVED' FOR SHARE;
 RETURN FOUND;
END $$;

CREATE FUNCTION uoa_guard_group_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_org text;
BEGIN
 SELECT org_id INTO target_org FROM groups WHERE id=NEW.group_id;
 IF target_org IS NULL OR NOT uoa_group_membership_admission(target_org, NEW.user_id) THEN
   RAISE EXCEPTION 'Group membership unavailable' USING ERRCODE='23503';
 END IF;
 RETURN NEW;
END $$;

DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.uoa_group_membership_admission(text,text) SET search_path = %I, pg_temp', current_schema(), current_schema());
 EXECUTE format('ALTER FUNCTION %I.uoa_guard_group_membership() SET search_path = %I, pg_temp', current_schema(), current_schema());
 EXECUTE format('REVOKE ALL ON FUNCTION %I.uoa_group_membership_admission(text,text) FROM PUBLIC', current_schema());
 EXECUTE format('REVOKE ALL ON FUNCTION %I.uoa_guard_group_membership() FROM PUBLIC', current_schema());
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.uoa_group_membership_admission(text,text) TO uoa_app,uoa_admin', current_schema());
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.uoa_guard_group_membership() TO uoa_app,uoa_admin', current_schema());
END $$;
CREATE TRIGGER group_membership_admission BEFORE INSERT OR UPDATE OF group_id,user_id ON group_members
 FOR EACH ROW EXECUTE FUNCTION uoa_guard_group_membership();

-- Repair only orphaned/REMOVED-org grants. DEACTIVATED membership retains its
-- administrative metadata, as before. Deletion jobs retain their own progress.
DO $$ DECLARE target record; BEGIN
 FOR target IN SELECT DISTINCT gm.user_id FROM group_members gm JOIN groups g ON g.id=gm.group_id
  WHERE NOT EXISTS(SELECT 1 FROM org_members om WHERE om.org_id=g.org_id AND om.user_id=gm.user_id AND om.status<>'REMOVED')
  ORDER BY gm.user_id
 LOOP
  -- Byte-for-byte JSON.stringify([namespace,userId]) used by the API lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('["uoa:refresh-session:user:v1",' || to_json(target.user_id)::text || ']', 0));
 END LOOP;
 FOR target IN SELECT DISTINCT g.org_id FROM group_members gm JOIN groups g ON g.id=gm.group_id
  WHERE NOT EXISTS(SELECT 1 FROM org_members om WHERE om.org_id=g.org_id AND om.user_id=gm.user_id AND om.status<>'REMOVED')
  ORDER BY g.org_id
 LOOP PERFORM pg_advisory_xact_lock(hashtextextended('uoa:directory-org:v1:' || target.org_id, 0)); END LOOP;
 FOR target IN SELECT gm.id,gm.user_id,g.org_id FROM group_members gm JOIN groups g ON g.id=gm.group_id
  WHERE NOT EXISTS(SELECT 1 FROM org_members om WHERE om.org_id=g.org_id AND om.user_id=gm.user_id AND om.status<>'REMOVED')
  ORDER BY g.org_id,gm.user_id,gm.id
 LOOP
  DELETE FROM group_members WHERE id=target.id;
  PERFORM uoa_record_directory_change('group-repair:' || target.id, target.org_id, 'membership.changed', target.user_id, NULL);
 END LOOP;
END $$;
COMMIT;
