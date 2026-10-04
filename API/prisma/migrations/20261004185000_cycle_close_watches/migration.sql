BEGIN;

CREATE TABLE billing_cycle_close_watches (
  id TEXT PRIMARY KEY,
  source_kind VARCHAR(24) NOT NULL,
  source_id VARCHAR(255) NOT NULL,
  service_id TEXT NOT NULL REFERENCES billing_services(id) ON DELETE RESTRICT,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  team_id TEXT,
  billing_month CHAR(7) NOT NULL,
  priority INTEGER NOT NULL DEFAULT 1,
  next_check_at TIMESTAMPTZ NOT NULL,
  generation BIGINT NOT NULL DEFAULT 0,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_cycle_id TEXT,
  last_error_code VARCHAR(100),
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_cycle_close_watches_source_month_key
    UNIQUE (source_kind, source_id, billing_month),
  CONSTRAINT billing_cycle_close_watches_month_check
    CHECK (billing_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT billing_cycle_close_watches_source_check
    CHECK (source_kind IN ('stripe', 'manual', 'team_discovery', 'team_usage')),
  CONSTRAINT billing_cycle_close_watches_team_check
    CHECK ((source_kind IN ('manual', 'team_discovery') AND team_id IS NULL)
      OR (source_kind = 'team_usage' AND team_id IS NOT NULL)
      OR source_kind = 'stripe'),
  CONSTRAINT billing_cycle_close_watches_nonnegative_check
    CHECK (priority >= 0 AND attempts >= 0 AND generation >= 0),
  CONSTRAINT billing_cycle_close_watches_lease_check
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX billing_cycle_close_watches_due_idx
  ON billing_cycle_close_watches(priority, next_check_at);
CREATE INDEX billing_cycle_close_watches_scope_idx
  ON billing_cycle_close_watches(service_id, org_id, team_id, billing_month);

CREATE FUNCTION billing_cycle_close_watch_identity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.source_kind IS DISTINCT FROM OLD.source_kind
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.service_id IS DISTINCT FROM OLD.service_id
    OR NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.team_id IS DISTINCT FROM OLD.team_id
    OR NEW.billing_month IS DISTINCT FROM OLD.billing_month THEN
    RAISE EXCEPTION 'billing cycle close watch source is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_cycle_close_watch_identity_guard
BEFORE UPDATE ON billing_cycle_close_watches
FOR EACH ROW EXECUTE FUNCTION billing_cycle_close_watch_identity_guard();

CREATE TABLE billing_cycle_seed_progress (
  kind VARCHAR(24) PRIMARY KEY,
  last_key VARCHAR(520) NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_cycle_seed_progress_kind_check
    CHECK (kind IN ('stripe', 'manual', 'team_discovery'))
);

GRANT SELECT, INSERT, UPDATE ON billing_cycle_close_watches TO uoa_app, uoa_admin;
GRANT SELECT, INSERT, UPDATE ON billing_cycle_seed_progress TO uoa_app, uoa_admin;

COMMIT;
