BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Admission and publication share one global namespace. Existing duplicate
-- labels stay blocked; this migration never chooses an owner or renames an org.
LOCK TABLE organisations IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE organisation_slug_claims (
  slug varchar(63) PRIMARY KEY,
  org_id text REFERENCES organisations(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX organisation_slug_claims_org_id_idx ON organisation_slug_claims(org_id);
ALTER TABLE organisation_slug_claims ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Organisation address admission requires a BYPASSRLS migration role';
  END IF;
END $$;

INSERT INTO organisation_slug_claims(slug, org_id)
SELECT slug, CASE WHEN count(*) = 1 THEN min(id) ELSE NULL END
FROM organisations GROUP BY slug;

CREATE FUNCTION uoa_organisation_slug_taken(candidate text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM organisation_slug_claims WHERE slug = candidate)
$$;

CREATE FUNCTION uoa_admit_organisation_slug() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE claimed_owner text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.slug IS NOT DISTINCT FROM OLD.slug THEN RETURN NEW; END IF;

  -- Terminal deletion uses an internal placeholder, not a published address.
  -- Keep the previous reservation; another domain cannot obstruct deletion by
  -- preclaiming its predictable placeholder. Lifecycle guards prohibit revival.
  IF NEW.lifecycle_status = 'DELETED' THEN RETURN NEW; END IF;

  INSERT INTO organisation_slug_claims(slug, org_id) VALUES (NEW.slug, NEW.id)
  ON CONFLICT (slug) DO UPDATE SET org_id = organisation_slug_claims.org_id
  RETURNING org_id INTO claimed_owner;
  IF claimed_owner IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'ORG_SLUG_TAKEN' USING ERRCODE = '23505',
      CONSTRAINT = 'organisations_slug_admission_key', TABLE = 'organisations', COLUMN = 'slug',
      DETAIL = format('Key (slug)=(%s) already exists.', NEW.slug);
  END IF;

  -- Explicit address changes retain their existing release semantics. A NULL
  -- legacy collision reservation is never released by one of its former users.
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM organisation_slug_claims WHERE slug = OLD.slug AND org_id = OLD.id;
  END IF;
  RETURN NEW;
END $$;

DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION %I.uoa_organisation_slug_taken(text) SET search_path = pg_catalog, %I, pg_temp',
    current_schema(), current_schema());
  EXECUTE format('ALTER FUNCTION %I.uoa_admit_organisation_slug() SET search_path = pg_catalog, %I, pg_temp',
    current_schema(), current_schema());
  EXECUTE format('REVOKE ALL ON FUNCTION %I.uoa_admit_organisation_slug() FROM PUBLIC', current_schema());
END $$;

CREATE TRIGGER organisation_slug_admission AFTER INSERT OR UPDATE OF slug ON organisations
FOR EACH ROW EXECUTE FUNCTION uoa_admit_organisation_slug();
COMMIT;
