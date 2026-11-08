BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
LOCK TABLE entity_deletion_jobs IN SHARE ROW EXCLUSIVE MODE;
-- An operator snapshot is useful, but only this locked recheck closes the old
-- revision's create/lease race. Keep incompatible jobs visible; never rewrite.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM entity_deletion_jobs WHERE scope='TEAM' AND status<>'COMPLETE'
    AND (preview->>'teamDeletionPolicy' IS DISTINCT FROM 'preserve-org-v2'
      OR preview->>'effectiveScope' IS DISTINCT FROM 'TEAM'
      OR preview->>'effectiveTargetId' IS DISTINCT FROM target_id)) THEN
    RAISE EXCEPTION 'DELETION_TEAM_SCOPE_RECONCILIATION_REQUIRED'; END IF;
END $$;
CREATE FUNCTION uoa_assert_team_deletion_scope(p_scope text,p_target text,p_preview jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_scope='TEAM' AND (p_preview->>'teamDeletionPolicy' IS DISTINCT FROM 'preserve-org-v2'
    OR p_preview->>'scope' IS DISTINCT FROM 'TEAM' OR p_preview->>'targetId' IS DISTINCT FROM p_target
    OR p_preview->>'effectiveScope' IS DISTINCT FROM 'TEAM'
    OR p_preview->>'effectiveTargetId' IS DISTINCT FROM p_target
    OR p_preview->'teamIds' IS DISTINCT FROM jsonb_build_array(p_target)
    OR p_preview->'deletesEmptyOrganisation' IS DISTINCT FROM 'false'::jsonb) THEN
    RAISE EXCEPTION 'DELETION_TEAM_SCOPE_RECONCILIATION_REQUIRED'; END IF;
END $$;
CREATE FUNCTION guard_team_deletion_policy_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.status='COMPLETE' AND NEW.status='COMPLETE' THEN RETURN NEW; END IF;
  PERFORM uoa_assert_team_deletion_scope(NEW.scope::text,NEW.target_id,NEW.preview);
  IF NEW.scope='TEAM' AND NEW.lease_owner IS NOT NULL AND NEW.lease_owner NOT LIKE 'preserve-org-v2:%' THEN
    RAISE EXCEPTION 'DELETION_TEAM_EXECUTOR_UPGRADE_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entity_deletion_team_policy_revision BEFORE INSERT OR UPDATE ON entity_deletion_jobs
  FOR EACH ROW EXECUTE FUNCTION guard_team_deletion_policy_revision();
COMMIT;
