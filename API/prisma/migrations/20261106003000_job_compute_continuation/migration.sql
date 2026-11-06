SET lock_timeout = '5s';
SET statement_timeout = '120s';

ALTER TABLE billing_job_compute_renewals
  ADD COLUMN continuation_of_id TEXT REFERENCES billing_job_compute_renewals(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX billing_job_compute_renewals_continuation_of_id_key
  ON billing_job_compute_renewals(continuation_of_id);

-- A continuation changes only the attempt and its one-use delivery secret.
-- Existing grants and their historical authority remain untouched.
CREATE FUNCTION enforce_job_compute_continuation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent billing_job_compute_renewals%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.continuation_of_id IS DISTINCT FROM OLD.continuation_of_id
      OR (OLD.continuation_of_id IS NOT NULL AND
        (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at'))
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
      RAISE EXCEPTION 'job compute continuation authority is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.continuation_of_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO parent FROM billing_job_compute_renewals WHERE id = NEW.continuation_of_id;
  IF NOT FOUND OR parent.revoked_at IS NOT NULL OR parent.expires_at <= clock_timestamp()
    OR parent.origin_product <> 'deepwater' OR parent.purpose <> 'research_compute'
    OR parent.scope_turn_id IS NOT NULL OR parent.parent_sales_job_grant_id IS NOT NULL
    OR NEW.id = parent.id OR NEW.ledger_job_id = parent.ledger_job_id
    OR NEW.expires_at > parent.expires_at
    OR (to_jsonb(NEW) - ARRAY['id','ledger_job_id','issue_key','identity_key','secret_digest',
        'created_at','expires_at','revoked_at','continuation_of_id']) IS DISTINCT FROM
       (to_jsonb(parent) - ARRAY['id','ledger_job_id','issue_key','identity_key','secret_digest',
        'created_at','expires_at','revoked_at','continuation_of_id']) THEN
    RAISE EXCEPTION 'job compute continuation binding is invalid';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_job_compute_continuation_authority
  BEFORE INSERT OR UPDATE ON billing_job_compute_renewals
  FOR EACH ROW EXECUTE FUNCTION enforce_job_compute_continuation();
