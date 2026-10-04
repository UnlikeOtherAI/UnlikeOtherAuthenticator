-- Preserve a same-millisecond baseline as explicit zero-duration evidence.
ALTER TABLE billing_seat_membership_intervals
  DROP CONSTRAINT billing_seat_interval_time_check;
ALTER TABLE billing_seat_membership_intervals
  ADD CONSTRAINT billing_seat_interval_time_check
  CHECK (ends_at IS NULL OR ends_at >= starts_at);

CREATE OR REPLACE FUNCTION billing_seat_touch_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  row_data jsonb;
  old_data jsonb;
  candidate_org_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN row_data := to_jsonb(OLD);
  ELSE row_data := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN old_data := to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME = 'billing_fixed_seat_capacity_revisions' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Capacity revisions are append-only' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'billing_seat_subscriptions' AND TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Seat subscriptions are append-only' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'billing_seat_subscriptions' AND TG_OP = 'UPDATE' THEN
    IF (NEW.org_id, NEW.team_id, NEW.scope, NEW.seat_policy, NEW.seat_charge_timing,
      NEW.activated_at, NEW.baseline_captured_at, NEW.service_id, NEW.tariff_id,
      NEW.unit_amount_minor, NEW.currency, NEW.stripe_subscription_id,
      NEW.contract_service_term_id) IS DISTINCT FROM
     (OLD.org_id, OLD.team_id, OLD.scope, OLD.seat_policy, OLD.seat_charge_timing,
      OLD.activated_at, OLD.baseline_captured_at, OLD.service_id, OLD.tariff_id,
      OLD.unit_amount_minor, OLD.currency, OLD.stripe_subscription_id,
      OLD.contract_service_term_id) THEN
      RAISE EXCEPTION 'Seat subscription terms are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  FOR candidate_org_id IN
    SELECT DISTINCT org_id FROM (
      SELECT om.org_id FROM org_members om
        WHERE TG_TABLE_NAME = 'users'
          AND om.user_id = COALESCE(row_data->>'id', old_data->>'id')
      UNION SELECT i.org_id FROM team_invites i
        WHERE TG_TABLE_NAME = 'users'
          AND lower(i.email) IN (lower(row_data->>'email'), lower(old_data->>'email'))
      UNION SELECT t.org_id FROM teams t
        WHERE TG_TABLE_NAME = 'team_members'
          AND t.id IN (row_data->>'team_id', old_data->>'team_id')
      UNION SELECT s.org_id FROM billing_seat_subscriptions s
        WHERE TG_TABLE_NAME = 'billing_fixed_seat_capacity_revisions'
          AND s.id = row_data->>'seat_subscription_id'
      UNION SELECT row_data->>'org_id' AS org_id
        WHERE TG_TABLE_NAME IN ('org_members', 'teams', 'team_invites',
          'billing_seat_subscriptions')
      UNION SELECT old_data->>'org_id' AS org_id
        WHERE TG_OP = 'UPDATE' AND TG_TABLE_NAME IN
          ('org_members', 'teams', 'team_invites')
    ) affected WHERE org_id IS NOT NULL ORDER BY org_id
  LOOP
    PERFORM billing_seat_touch_org(candidate_org_id);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION billing_seat_refresh_org(p_org_id TEXT) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  subscription_row billing_seat_subscriptions%ROWTYPE;
  member_row record;
  observed_at timestamp(3) := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
  scoped_team_id text;
  occupied integer;
  reserved integer;
  capacity integer;
  open_row record;
BEGIN
  FOR subscription_row IN SELECT * FROM billing_seat_subscriptions
      WHERE org_id = p_org_id ORDER BY id
  LOOP
    scoped_team_id := CASE WHEN subscription_row.scope = 'TEAM' THEN subscription_row.team_id ELSE NULL END;
    IF subscription_row.baseline_member_count IS NULL THEN
      IF subscription_row.activated_at < (transaction_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '1 second'
         OR subscription_row.activated_at > observed_at + interval '1 second' THEN
        RAISE EXCEPTION 'Seat baseline must be captured at observed activation'
          USING ERRCODE = '23514', CONSTRAINT = 'billing_seat_activation_time';
      END IF;
      SELECT count(*) INTO occupied FROM billing_seat_eligible(p_org_id, scoped_team_id);
      UPDATE billing_seat_subscriptions SET baseline_member_count = occupied
        WHERE id = subscription_row.id;
      IF subscription_row.seat_policy = 'AUTOMATIC' THEN
        INSERT INTO billing_seat_membership_intervals
          (id, seat_subscription_id, user_id, starts_at, baseline)
        SELECT gen_random_uuid()::text, subscription_row.id, user_id,
          subscription_row.activated_at, true
        FROM billing_seat_eligible(p_org_id, scoped_team_id);
      END IF;
    END IF;

    IF subscription_row.seat_policy = 'AUTOMATIC' THEN
      FOR open_row IN SELECT i.id, i.starts_at FROM billing_seat_membership_intervals i
        WHERE i.seat_subscription_id = subscription_row.id AND i.ends_at IS NULL
          AND (subscription_row.ended_at IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM billing_seat_eligible(p_org_id, scoped_team_id) e
            WHERE e.user_id = i.user_id))
      LOOP
        -- A join and leave in the same millisecond has zero liability. Keep
        -- a zero-duration marker has no liability but proves baseline capture.
        UPDATE billing_seat_membership_intervals
          SET ends_at = GREATEST(COALESCE(subscription_row.ended_at, observed_at), open_row.starts_at)
          WHERE id = open_row.id;
      END LOOP;
      IF subscription_row.ended_at IS NULL THEN
        INSERT INTO billing_seat_membership_intervals
          (id, seat_subscription_id, user_id, starts_at, baseline)
        SELECT gen_random_uuid()::text, subscription_row.id, e.user_id,
          observed_at, false
        FROM billing_seat_eligible(p_org_id, scoped_team_id) e
        WHERE NOT EXISTS (
          SELECT 1 FROM billing_seat_membership_intervals i
          WHERE i.seat_subscription_id = subscription_row.id
            AND i.user_id = e.user_id AND i.ends_at IS NULL)
        ON CONFLICT (seat_subscription_id, user_id, starts_at)
          DO UPDATE SET ends_at = NULL;
      END IF;
    ELSIF subscription_row.seat_policy = 'FIXED' THEN
      SELECT r.quantity INTO capacity FROM billing_fixed_seat_capacity_revisions r
        WHERE r.seat_subscription_id = subscription_row.id
          AND r.effective_at <= observed_at
        ORDER BY r.effective_at DESC LIMIT 1;
      IF capacity IS NULL THEN
        RAISE EXCEPTION 'Fixed seat subscription requires an active capacity revision'
          USING ERRCODE = '23514', CONSTRAINT = 'billing_seat_initial_capacity';
      END IF;
      IF subscription_row.ended_at IS NOT NULL THEN CONTINUE; END IF;
      SELECT count(*) INTO occupied FROM billing_seat_eligible(p_org_id, scoped_team_id);
      SELECT count(DISTINCT lower(trim(i.email))) INTO reserved
      FROM team_invites i
      JOIN teams t ON t.id = i.team_id AND t.lifecycle_status = 'ACTIVE'
      JOIN organisations o ON o.id = i.org_id AND o.lifecycle_status = 'ACTIVE'
      WHERE i.org_id = p_org_id
        AND (scoped_team_id IS NULL OR i.team_id = scoped_team_id)
        AND i.accepted_at IS NULL AND i.declined_at IS NULL AND i.revoked_at IS NULL
        AND (i.expires_at IS NULL OR i.expires_at > observed_at)
        AND i.approval_status <> 'DENIED'
        AND NOT EXISTS (SELECT 1 FROM billing_seat_eligible(p_org_id, scoped_team_id) e
          WHERE e.email = lower(trim(i.email)));
      IF occupied + reserved > capacity OR EXISTS (
        SELECT 1 FROM billing_fixed_seat_capacity_revisions future
        WHERE future.seat_subscription_id = subscription_row.id
          AND future.effective_at > observed_at
          AND future.quantity < occupied + reserved) THEN
        RAISE EXCEPTION 'Fixed seat capacity exceeded for subscription %', subscription_row.id
          USING ERRCODE = 'PZ001', CONSTRAINT = 'billing_seat_capacity_exceeded';
      END IF;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION billing_seat_refresh_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  row_data jsonb;
  old_data jsonb;
  candidate_org_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN row_data := to_jsonb(OLD);
  ELSE row_data := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN old_data := to_jsonb(OLD); END IF;
  FOR candidate_org_id IN
    SELECT DISTINCT org_id FROM (
      SELECT om.org_id FROM org_members om
        WHERE TG_TABLE_NAME = 'users'
          AND om.user_id = COALESCE(row_data->>'id', old_data->>'id')
      UNION SELECT i.org_id FROM team_invites i
        WHERE TG_TABLE_NAME = 'users'
          AND lower(i.email) IN (lower(row_data->>'email'), lower(old_data->>'email'))
      UNION SELECT t.org_id FROM teams t
        WHERE TG_TABLE_NAME = 'team_members'
          AND t.id IN (row_data->>'team_id', old_data->>'team_id')
      UNION SELECT s.org_id FROM billing_seat_subscriptions s
        WHERE TG_TABLE_NAME = 'billing_fixed_seat_capacity_revisions'
          AND s.id = row_data->>'seat_subscription_id'
      UNION SELECT row_data->>'id' AS org_id
        WHERE TG_TABLE_NAME = 'organisations'
      UNION SELECT row_data->>'org_id' AS org_id
        WHERE TG_TABLE_NAME IN ('org_members', 'teams', 'team_invites',
          'billing_seat_subscriptions')
      UNION SELECT old_data->>'org_id' AS org_id
        WHERE TG_OP = 'UPDATE' AND TG_TABLE_NAME IN
          ('org_members', 'teams', 'team_invites')
    ) affected WHERE org_id IS NOT NULL ORDER BY org_id
  LOOP
    PERFORM billing_seat_refresh_org(candidate_org_id);
  END LOOP;
  RETURN NULL;
END $$;


-- A captured baseline and a completed subscription are immutable. Ending is
-- an observed event, never a backdated correction or future roster snapshot.
CREATE FUNCTION billing_seat_validate_subscription_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE observed_at timestamp(3) := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.baseline_member_count IS NOT NULL THEN
      RAISE EXCEPTION 'Seat baseline must be captured by the roster trigger'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.baseline_member_count IS NOT NULL AND
      NEW.baseline_member_count IS DISTINCT FROM OLD.baseline_member_count THEN
    RAISE EXCEPTION 'Captured seat baseline is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN
    RAISE EXCEPTION 'Seat subscription ending is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL AND
      (NEW.ended_at < (transaction_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '1 second'
        OR NEW.ended_at > observed_at + interval '1 second') THEN
    RAISE EXCEPTION 'Seat subscription must end at observed time' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_seat_validate_subscription_update
  BEFORE INSERT OR UPDATE ON billing_seat_subscriptions
  FOR EACH ROW EXECUTE FUNCTION billing_seat_validate_subscription_update();

-- Interval history is written only by the roster trigger, never by a route or
-- a backfill script. Corrections require an explicit audited reconciliation.
CREATE FUNCTION billing_seat_guard_interval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Seat membership evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_seat_guard_interval BEFORE INSERT OR UPDATE OR DELETE
  ON billing_seat_membership_intervals
  FOR EACH ROW EXECUTE FUNCTION billing_seat_guard_interval();

-- No caller should use the privileged roster functions as a data API.
REVOKE ALL ON FUNCTION billing_seat_eligible(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_seat_refresh_org(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_seat_touch_org(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_seat_touch_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_seat_refresh_change() FROM PUBLIC;

DO $$
DECLARE function_signature text;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'billing_seat_touch_change()', 'billing_seat_refresh_org(text)',
    'billing_seat_refresh_change()']
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I',
      function_signature, current_schema());
  END LOOP;
END $$;
