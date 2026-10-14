SET lock_timeout = '5s';
SET statement_timeout = '120s';
-- Narrow definer boundary: app callers may invalidate only their resolved org,
-- their explicitly authenticated backend domain, or an org they just created.
-- Direct access to the machine-only cursor/outbox tables remains denied by RLS.
CREATE FUNCTION uoa_record_directory_change(p_id text, p_org_id text, p_kind text, p_subject_id text, p_team_id text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
 caller_role text := COALESCE(NULLIF(current_setting('role', true), 'none'), session_user);
 privileged boolean;
 next_revision bigint;
BEGIN
 SELECT COALESCE(rolsuper OR rolbypassrls, false) INTO privileged FROM pg_roles WHERE rolname=caller_role;
 IF NOT COALESCE(privileged, false) AND NOT EXISTS (
   SELECT 1 FROM organisations o WHERE o.id=p_org_id AND (
     o.id=NULLIF(current_setting('app.org_id', true), '') OR
     (o.domain=NULLIF(current_setting('app.domain', true), '') AND (
       current_setting('app.domain_backend', true)='on' OR
       o.owner_id=NULLIF(current_setting('app.user_id', true), '')
     ))
   )
 ) THEN RAISE EXCEPTION 'directory mutation outside tenant context' USING ERRCODE='42501'; END IF;
 IF p_org_id='' OR p_kind NOT IN ('organisation.changed','organisation.deleted','team.changed',
   'team.deleted','membership.changed','profile.changed','credential_epoch.changed') THEN
   RAISE EXCEPTION 'invalid directory change' USING ERRCODE='22023';
 END IF;
 -- Reentrant: the service takes this before its first canonical write and holds
 -- it until commit. Keeping it here also prevents an unprotected allocator.
 PERFORM pg_advisory_xact_lock(hashtextextended('uoa:directory-org:v1:' || p_org_id, 0));
 INSERT INTO directory_organisation_revisions(org_id, revision) VALUES(p_org_id, 1)
 ON CONFLICT(org_id) DO UPDATE SET revision=directory_organisation_revisions.revision+1
 RETURNING revision INTO next_revision;
 INSERT INTO directory_change_outbox(id, org_id, revision, kind, subject_id, team_id)
 VALUES(p_id, p_org_id, next_revision, p_kind, p_subject_id, p_team_id);
 RETURN next_revision;
END
$$;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.uoa_record_directory_change(text,text,text,text,text) SET search_path = %I, pg_temp', current_schema(), current_schema());
 EXECUTE format('REVOKE ALL ON FUNCTION %I.uoa_record_directory_change(text,text,text,text,text) FROM PUBLIC', current_schema());
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.uoa_record_directory_change(text,text,text,text,text) TO uoa_app,uoa_admin', current_schema());
END $$;
