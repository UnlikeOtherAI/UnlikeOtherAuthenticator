SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- These triggers append machine fences in the SOURCE transaction. They acquire
-- no new global/outbox lock and never edit a human assurance or refresh family.
CREATE FUNCTION machine_source_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n jsonb; o jsonb; predicate text; target_status text; target_reason text;
BEGIN
 n := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 o := CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 target_status := 'revoked';
 IF TG_TABLE_NAME='users' THEN
  IF TG_OP='UPDATE' AND n->'token_version' IS DISTINCT FROM o->'token_version' THEN
   predicate := format('e.subject=%L',n->>'id'); target_reason := 'security_reset';
  ELSIF TG_OP='DELETE' OR n->>'lifecycle_status'<>'ACTIVE'
    OR (n->>'account_expires_at')::timestamptz<=clock_timestamp() THEN
   predicate := format('e.subject=%L',n->>'id'); target_reason := 'account_unavailable';
  ELSIF n->>'2fa_enabled'='true' AND n->'2fa_enabled' IS DISTINCT FROM o->'2fa_enabled' THEN
   predicate := format('e.subject=%L AND EXISTS(SELECT 1 FROM machine_authorizations a
    WHERE a.id=e.current_authorization_id AND NOT a.personal_factor_completed)',n->>'id');
   target_status := 'reauthorization_required'; target_reason := 'authentication_policy_changed';
  ELSE RETURN NULL; END IF;
 ELSIF TG_TABLE_NAME='client_domains' THEN
  IF TG_OP='DELETE' OR n->>'status'<>'active' THEN
   predicate := format('e.client_domain=%L',n->>'domain'); target_reason := 'product_disabled';
  ELSIF n->>'two_fa_policy'='REQUIRED' AND n->'two_fa_policy' IS DISTINCT FROM o->'two_fa_policy' THEN
   predicate := format('e.client_domain=%L AND EXISTS(SELECT 1 FROM machine_authorizations a
    WHERE a.id=e.current_authorization_id AND NOT a.personal_factor_completed)',n->>'domain');
   target_status := 'reauthorization_required'; target_reason := 'authentication_policy_changed';
  ELSE RETURN NULL; END IF;
 ELSIF TG_TABLE_NAME='domain_roles' THEN
  IF TG_OP<>'DELETE' THEN RETURN NULL; END IF;
  predicate := format('e.client_domain=%L AND e.subject=%L',n->>'domain',n->>'user_id');
  target_status := 'access_removed'; target_reason := 'access_removed';
 ELSIF TG_TABLE_NAME IN ('organisations','teams') THEN
  IF TG_OP='DELETE' OR n->>'lifecycle_status'<>'ACTIVE' THEN
   predicate := format('e.%I=%L',CASE WHEN TG_TABLE_NAME='teams' THEN 'team_id' ELSE 'org_id' END,n->>'id');
   target_status := 'access_removed'; target_reason := 'access_removed';
  ELSIF TG_TABLE_NAME='organisations' AND n->>'two_fa_policy'='REQUIRED'
    AND n->'two_fa_policy' IS DISTINCT FROM o->'two_fa_policy' THEN
   predicate := format('e.org_id=%L AND EXISTS(SELECT 1 FROM machine_authorizations a
    WHERE a.id=e.current_authorization_id AND NOT a.personal_factor_completed)',n->>'id');
   target_status := 'reauthorization_required'; target_reason := 'authentication_policy_changed';
  ELSE RETURN NULL; END IF;
 ELSIF TG_TABLE_NAME IN ('org_members','team_members') THEN
  IF TG_OP<>'DELETE' AND n->>'status'='ACTIVE' AND n->'role' IS NOT DISTINCT FROM o->'role'
    THEN RETURN NULL; END IF;
  predicate := format('e.subject=%L AND e.%I=%L',n->>'user_id',
    CASE WHEN TG_TABLE_NAME='team_members' THEN 'team_id' ELSE 'org_id' END,
    CASE WHEN TG_TABLE_NAME='team_members' THEN n->>'team_id' ELSE n->>'org_id' END);
  -- Current org-manager authority is canonical and needs no synthetic TeamMember.
  predicate := predicate || ' AND NOT EXISTS (SELECT 1 FROM org_members om
   JOIN organisations org ON org.id=om.org_id JOIN teams t ON t.org_id=org.id
   WHERE om.user_id=e.subject AND om.org_id=e.org_id AND om.status=''ACTIVE''
    AND org.lifecycle_status=''ACTIVE'' AND t.id=e.team_id AND t.lifecycle_status=''ACTIVE''
    AND (org.owner_id=e.subject OR om.role IN (''owner'',''admin'') OR EXISTS
     (SELECT 1 FROM team_members tm WHERE tm.user_id=e.subject AND tm.team_id=e.team_id AND tm.status=''ACTIVE'')))';
  target_status := 'access_removed'; target_reason := 'access_removed';
 ELSIF TG_TABLE_NAME='org_sso_policies' THEN
  IF TG_OP='UPDATE' AND n->'generation' IS NOT DISTINCT FROM o->'generation' THEN RETURN NULL; END IF;
  predicate := format('e.client_domain=%L AND e.org_id=%L',n->>'client_domain',n->>'org_id');
  target_status := 'reauthorization_required'; target_reason := 'sso_policy_changed';
 ELSIF TG_TABLE_NAME IN ('org_sso_connections','external_identities') THEN
  IF TG_OP='UPDATE' AND ROW(n->'status',n->'revision',n->'generation')
    IS NOT DISTINCT FROM ROW(o->'status',o->'revision',o->'generation') THEN RETURN NULL; END IF;
  predicate := format('EXISTS(SELECT 1 FROM machine_authorizations a WHERE a.id=e.current_authorization_id AND a.%I=%L)',
    CASE WHEN TG_TABLE_NAME='external_identities' THEN 'external_identity_id' ELSE 'connection_id' END,n->>'id');
  target_status := 'reauthorization_required'; target_reason := 'sso_policy_changed';
 ELSIF TG_TABLE_NAME='scim_resource_links' THEN
  IF n->>'resource_type'<>'Users' OR n->>'user_id' IS NULL OR n->>'subject_binding' IS NULL
    OR (TG_OP<>'DELETE' AND n->>'active'='true' AND n->>'deleted_at' IS NULL) THEN RETURN NULL; END IF;
  predicate := format('e.subject=%L AND EXISTS(SELECT 1 FROM machine_authorizations a
   WHERE a.id=e.current_authorization_id AND a.connection_id=%L AND a.external_identity_id=%L)',
   n->>'user_id',n->>'connection_id',n->>'subject_binding');
  target_status := 'reauthorization_required'; target_reason := 'sso_policy_changed';
 ELSIF TG_TABLE_NAME='organisation_email_domains' THEN
  IF TG_OP<>'DELETE' AND n->>'status'='VERIFIED'
    AND (n->>'last_verified_at')::timestamptz>clock_timestamp()-interval '1 day' THEN RETURN NULL; END IF;
  predicate := format('EXISTS(SELECT 1 FROM machine_authorizations a JOIN external_identities i
   ON i.id=a.external_identity_id WHERE a.id=e.current_authorization_id AND i.domain_claim_id=%L)',n->>'id');
  target_status := 'reauthorization_required'; target_reason := 'sso_policy_changed';
 ELSIF TG_TABLE_NAME IN ('billing_services','billing_app_keys') THEN
  -- Evaluate the complete mapping, so rotating an app key does not revoke a
  -- machine while another current exact Nessie key still supplies that mapping.
  predicate := 'NOT EXISTS (SELECT 1 FROM billing_app_keys k JOIN billing_services s ON s.id=k.service_id
    WHERE k.actor_issuer=''https://''||e.client_domain AND k.purpose=''CUSTOMER_LIFECYCLE'' AND s.identifier=''nessie''
     AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp()) AND s.active)
   OR (SELECT count(DISTINCT k.service_id) FROM billing_app_keys k JOIN billing_services s ON s.id=k.service_id
    WHERE k.actor_issuer=''https://''||e.client_domain AND k.purpose=''CUSTOMER_LIFECYCLE''
     AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp()) AND s.active)=0
   OR (SELECT count(DISTINCT k.service_id) FROM billing_app_keys k JOIN billing_services s ON s.id=k.service_id
    WHERE k.actor_issuer=''https://''||e.client_domain AND k.purpose=''CUSTOMER_LIFECYCLE''
     AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp()) AND s.active)>1';
  target_reason := 'product_disabled';
 ELSE RAISE EXCEPTION 'unknown machine authority source'; END IF;
 EXECUTE format('UPDATE machine_enrollments e SET status=%L,reason=%L,source_version=source_version+1
   WHERE (%s) AND (e.status=''allowed'' OR (e.status=''reauthorization_required'' AND %L<>''reauthorization_required''))',
   target_status,target_reason,predicate,target_status);
 RETURN NULL;
END $$;

CREATE TRIGGER machine_user_fence AFTER UPDATE OF token_version,lifecycle_status,account_expires_at,"2fa_enabled" OR DELETE ON users
 FOR EACH ROW EXECUTE FUNCTION machine_source_fence();
CREATE TRIGGER machine_domain_fence AFTER UPDATE OF status,two_fa_policy OR DELETE ON client_domains
 FOR EACH ROW EXECUTE FUNCTION machine_source_fence();
CREATE TRIGGER machine_role_fence AFTER DELETE ON domain_roles
 FOR EACH ROW EXECUTE FUNCTION machine_source_fence();
CREATE TRIGGER machine_org_fence AFTER UPDATE OF lifecycle_status,two_fa_policy OR DELETE ON organisations
 FOR EACH ROW EXECUTE FUNCTION machine_source_fence();
CREATE TRIGGER machine_team_fence AFTER UPDATE OF lifecycle_status OR DELETE ON teams
 FOR EACH ROW EXECUTE FUNCTION machine_source_fence();
CREATE TRIGGER machine_org_member_fence AFTER UPDATE OF status,role OR DELETE ON org_members
 FOR EACH ROW EXECUTE FUNCTION machine_source_fence();
CREATE TRIGGER machine_team_member_fence AFTER UPDATE OF status OR DELETE ON team_members
 FOR EACH ROW EXECUTE FUNCTION machine_source_fence();
CREATE TRIGGER machine_sso_policy_fence AFTER INSERT OR UPDATE OF generation OR DELETE ON org_sso_policies
 FOR EACH ROW EXECUTE FUNCTION machine_source_fence();
CREATE TRIGGER machine_sso_connection_fence AFTER UPDATE OF status,revision,generation OR DELETE ON org_sso_connections
 FOR EACH ROW EXECUTE FUNCTION machine_source_fence();
CREATE TRIGGER machine_external_identity_fence AFTER UPDATE OF status OR DELETE ON external_identities
 FOR EACH ROW EXECUTE FUNCTION machine_source_fence();
CREATE TRIGGER machine_scim_identity_fence AFTER INSERT OR UPDATE OF active,deleted_at,user_id,subject_binding OR DELETE ON scim_resource_links
 FOR EACH ROW EXECUTE FUNCTION machine_source_fence();
CREATE TRIGGER machine_sso_domain_claim_fence AFTER UPDATE OF status,last_verified_at OR DELETE ON organisation_email_domains
 FOR EACH ROW EXECUTE FUNCTION machine_source_fence();
CREATE TRIGGER machine_product_fence AFTER UPDATE OF active,identifier OR DELETE ON billing_services
 FOR EACH ROW EXECUTE FUNCTION machine_source_fence();
CREATE TRIGGER machine_product_key_fence AFTER INSERT OR UPDATE OF revoked_at,expires_at,service_id,actor_issuer,purpose OR DELETE ON billing_app_keys
 FOR EACH ROW EXECUTE FUNCTION machine_source_fence();

ALTER FUNCTION machine_source_fence() SECURITY DEFINER;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.machine_source_fence() SET search_path TO %I, pg_temp',current_schema(),current_schema());
END $$;
REVOKE ALL ON FUNCTION machine_source_fence() FROM PUBLIC;
