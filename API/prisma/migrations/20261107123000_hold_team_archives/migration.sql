SET lock_timeout = '5s';
SET statement_timeout = '120s';

ALTER TYPE "EntityLifecycleStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';

CREATE TABLE team_archive_operations (
  id UUID PRIMARY KEY,
  team_id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL,
  source_client_domain_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  deletion_held BOOLEAN NOT NULL DEFAULT true CHECK (deletion_held),
  billing_stopped_at TIMESTAMP(3),
  settle_after TIMESTAMP(3) NOT NULL,
  lease_owner UUID,
  lease_expires_at TIMESTAMP(3),
  next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (team_id, org_id) REFERENCES teams(id, org_id) ON DELETE RESTRICT
);
CREATE INDEX team_archive_operations_billing_stopped_at_next_attempt_at_idx
  ON team_archive_operations(billing_stopped_at, next_attempt_at);
CREATE UNIQUE INDEX team_archive_operations_team_id_org_id_key ON team_archive_operations(team_id, org_id);
ALTER TABLE team_archive_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_archive_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON team_archive_operations FROM PUBLIC, uoa_app;
GRANT SELECT, INSERT, UPDATE ON team_archive_operations TO uoa_admin;

CREATE FUNCTION hold_archived_team() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE held BOOLEAN;
BEGIN
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.team_archive_operations WHERE team_id=$1)', TG_TABLE_SCHEMA)
    INTO held USING OLD.id;
  IF held AND (TG_OP = 'DELETE' OR NEW.lifecycle_status::text <> 'ARCHIVED') THEN
    RAISE EXCEPTION 'team archive deletion is held' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hold_archived_team BEFORE DELETE OR UPDATE OF lifecycle_status ON teams
  FOR EACH ROW EXECUTE FUNCTION hold_archived_team();

CREATE FUNCTION preserve_team_archive_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR ROW(NEW.id, NEW.team_id, NEW.org_id,
      NEW.source_client_domain_id, NEW.actor_user_id, NEW.deletion_held, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.team_id, OLD.org_id,
      OLD.source_client_domain_id, OLD.actor_user_id, OLD.deletion_held, OLD.created_at)
    OR (OLD.billing_stopped_at IS NOT NULL AND NEW.billing_stopped_at IS DISTINCT FROM OLD.billing_stopped_at)
  THEN RAISE EXCEPTION 'team archive evidence is immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_team_archive_hold BEFORE UPDATE OR DELETE ON team_archive_operations
  FOR EACH ROW EXECUTE FUNCTION preserve_team_archive_hold();

-- Lifecycle cancellation has its own exact-team evidence. Retain the original
-- immutable consent revisions and monetary history; clear current consent pointers
-- without forging a customer billing action.
CREATE FUNCTION hold_archived_team_reload() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE held BOOLEAN;
BEGIN
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.team_archive_operations WHERE team_id=$1 AND org_id=$2)', TG_TABLE_SCHEMA)
    INTO held USING NEW.team_id, NEW.org_id;
  IF NEW.auto_top_up_state::text <> 'DISABLED' AND held THEN
    RAISE EXCEPTION 'archived team cannot enable reload' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hold_archived_team_reload BEFORE INSERT OR UPDATE ON billing_credit_accounts
  FOR EACH ROW EXECUTE FUNCTION hold_archived_team_reload();
CREATE OR REPLACE FUNCTION "billing_credit_auto_top_up_generation_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  snapshot_changed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."auto_top_up_generation" <> 0 THEN
      RAISE EXCEPTION 'new credit account generation must begin at zero'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  snapshot_changed := ROW(
    NEW."auto_top_up_policy_id", NEW."auto_top_up_service_id",
    NEW."auto_top_up_app_key_id", NEW."auto_top_up_consent_revision_id",
    NEW."auto_top_up_option_id", NEW."auto_top_up_threshold_microcredits",
    NEW."auto_top_up_refill_offer_id", NEW."auto_top_up_monthly_charge_cap_minor",
    NEW."auto_top_up_consent_version", NEW."auto_top_up_consented_at",
    NEW."auto_top_up_consented_by_user_id", NEW."stripe_payment_method_id",
    NEW."payment_method_summary"
  ) IS DISTINCT FROM ROW(
    OLD."auto_top_up_policy_id", OLD."auto_top_up_service_id",
    OLD."auto_top_up_app_key_id", OLD."auto_top_up_consent_revision_id",
    OLD."auto_top_up_option_id", OLD."auto_top_up_threshold_microcredits",
    OLD."auto_top_up_refill_offer_id", OLD."auto_top_up_monthly_charge_cap_minor",
    OLD."auto_top_up_consent_version", OLD."auto_top_up_consented_at",
    OLD."auto_top_up_consented_by_user_id", OLD."stripe_payment_method_id",
    OLD."payment_method_summary"
  );
  IF snapshot_changed AND NEW."auto_top_up_generation" <> OLD."auto_top_up_generation" + 1 THEN
    RAISE EXCEPTION 'automatic top-up consent change must advance generation once'
      USING ERRCODE = '23514';
  ELSIF NOT snapshot_changed
     AND NEW."auto_top_up_generation" <> OLD."auto_top_up_generation" THEN
    RAISE EXCEPTION 'automatic top-up generation changed without a consent change'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."auto_top_up_state" <> 'DISABLED' AND NEW."auto_top_up_state" = 'DISABLED'
     AND NOT EXISTS (SELECT 1 FROM team_archive_operations a JOIN teams t ON t.id=a.team_id WHERE a.team_id=OLD.team_id AND a.org_id=OLD.org_id AND t.lifecycle_status::text='ARCHIVED') AND NOT EXISTS (
       SELECT 1
       FROM "billing_credit_auto_top_up_disable_events" AS disable_event
       WHERE disable_event."credit_account_id" = OLD."id"
         AND disable_event."account_id" = OLD."account_id"
         AND disable_event."org_id" = OLD."org_id"
         AND disable_event."team_id" IS NOT DISTINCT FROM OLD."team_id"
         AND disable_event."previous_generation" = OLD."auto_top_up_generation"
         AND disable_event."previous_consent_revision_id"
           IS NOT DISTINCT FROM OLD."auto_top_up_consent_revision_id"
     ) THEN
    RAISE EXCEPTION 'automatic top-up disable requires manager-audited evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
