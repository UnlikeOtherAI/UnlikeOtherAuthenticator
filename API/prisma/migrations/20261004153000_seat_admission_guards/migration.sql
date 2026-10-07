-- Every admission writer must modify the same row before its deferred count. A
-- row write, unlike an advisory lock alone, also forces stale SERIALIZABLE
-- transactions to retry. READ COMMITTED sees the preceding writer at commit.
ALTER TABLE "organisations"
  ADD COLUMN "billing_seat_guard_version" BIGINT NOT NULL DEFAULT 0;

CREATE FUNCTION billing_seat_touch_org(p_org_id TEXT) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_org_id IS NOT NULL THEN
    UPDATE organisations SET billing_seat_guard_version = billing_seat_guard_version + 1
      WHERE id = p_org_id;
  END IF;
END $$;

CREATE FUNCTION billing_seat_touch_change() RETURNS trigger
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
  IF TG_TABLE_NAME = 'users' THEN
    FOR candidate_org_id IN
      SELECT DISTINCT org_id FROM (
        SELECT org_id FROM org_members WHERE user_id = COALESCE(row_data->>'id', old_data->>'id')
        UNION SELECT org_id FROM team_invites
          WHERE lower(email) IN (lower(row_data->>'email'), lower(old_data->>'email'))
      ) affected ORDER BY org_id
    LOOP
      PERFORM billing_seat_touch_org(candidate_org_id);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'team_members' THEN
    SELECT org_id INTO candidate_org_id FROM teams WHERE id = row_data->>'team_id';
    PERFORM billing_seat_touch_org(candidate_org_id);
  ELSIF TG_TABLE_NAME = 'billing_fixed_seat_capacity_revisions' THEN
    SELECT org_id INTO candidate_org_id FROM billing_seat_subscriptions
      WHERE id = row_data->>'seat_subscription_id';
    PERFORM billing_seat_touch_org(candidate_org_id);
  ELSIF TG_TABLE_NAME <> 'organisations' THEN
    PERFORM billing_seat_touch_org(row_data->>'org_id');
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

-- A scoped roster is UOA's active human membership, not an invitation or a
-- product-local copy. Organisation scope deduplicates the same person in teams.
CREATE FUNCTION billing_seat_eligible(p_org_id TEXT, p_team_id TEXT)
RETURNS TABLE(user_id TEXT, email TEXT)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT DISTINCT u.id, lower(u.email::text)
  FROM org_members om
  JOIN users u ON u.id = om.user_id AND u.lifecycle_status = 'ACTIVE'
  JOIN organisations o ON o.id = om.org_id AND o.lifecycle_status = 'ACTIVE'
  WHERE om.org_id = p_org_id AND om.status = 'ACTIVE'
    AND (p_team_id IS NULL OR EXISTS (
      SELECT 1 FROM team_members tm JOIN teams t ON t.id = tm.team_id
      WHERE tm.user_id = u.id AND tm.team_id = p_team_id AND tm.status = 'ACTIVE'
        AND t.org_id = p_org_id AND t.lifecycle_status = 'ACTIVE'));
$$;

CREATE FUNCTION billing_seat_refresh_org(p_org_id TEXT) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  subscription_row billing_seat_subscriptions%ROWTYPE;
  member_row record;
  observed_at timestamp(3) := clock_timestamp()::timestamp(3);
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
      IF subscription_row.activated_at < transaction_timestamp()::timestamp(3) - interval '1 second'
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
        -- no invalid zero-length interval or false full-month evidence.
        IF COALESCE(subscription_row.ended_at, observed_at) <= open_row.starts_at THEN
          DELETE FROM billing_seat_membership_intervals WHERE id = open_row.id;
        ELSE
          UPDATE billing_seat_membership_intervals
            SET ends_at = COALESCE(subscription_row.ended_at, observed_at)
            WHERE id = open_row.id;
        END IF;
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
            AND i.user_id = e.user_id AND i.ends_at IS NULL);
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

CREATE FUNCTION billing_seat_refresh_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  row_data jsonb;
  old_data jsonb;
  candidate_org_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN row_data := to_jsonb(OLD);
  ELSE row_data := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN old_data := to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME = 'users' THEN
    FOR candidate_org_id IN
      SELECT DISTINCT org_id FROM (
        SELECT org_id FROM org_members WHERE user_id = COALESCE(row_data->>'id', old_data->>'id')
        UNION SELECT org_id FROM team_invites
          WHERE lower(email) IN (lower(row_data->>'email'), lower(old_data->>'email'))
      ) affected ORDER BY org_id
    LOOP
      PERFORM billing_seat_refresh_org(candidate_org_id);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'team_members' THEN
    SELECT org_id INTO candidate_org_id FROM teams WHERE id = row_data->>'team_id';
    PERFORM billing_seat_refresh_org(candidate_org_id);
  ELSIF TG_TABLE_NAME = 'billing_fixed_seat_capacity_revisions' THEN
    SELECT org_id INTO candidate_org_id FROM billing_seat_subscriptions
      WHERE id = row_data->>'seat_subscription_id';
    PERFORM billing_seat_refresh_org(candidate_org_id);
  ELSIF TG_TABLE_NAME = 'organisations' THEN
    PERFORM billing_seat_refresh_org(row_data->>'id');
  ELSE
    PERFORM billing_seat_refresh_org(row_data->>'org_id');
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER billing_seat_org_lifecycle_refresh
  AFTER UPDATE OF lifecycle_status ON organisations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION billing_seat_refresh_change();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['org_members', 'team_members', 'team_invites',
      'users', 'teams', 'billing_seat_subscriptions', 'billing_fixed_seat_capacity_revisions']
  LOOP
    EXECUTE format('CREATE TRIGGER billing_seat_touch BEFORE INSERT OR UPDATE OR DELETE ON %I '
      || 'FOR EACH ROW EXECUTE FUNCTION billing_seat_touch_change()', table_name);
    EXECUTE format('CREATE CONSTRAINT TRIGGER billing_seat_refresh AFTER INSERT OR UPDATE OR DELETE ON %I '
      || 'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_seat_refresh_change()', table_name);
  END LOOP;
END $$;

-- Pin definer functions to the schema that owns their tables. This is public in
-- production and the isolated schema in persistence tests; callers cannot
-- redirect privileged reads through their search_path.
DO $$
DECLARE function_signature text;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'billing_seat_touch_org(text)', 'billing_seat_touch_change()',
    'billing_seat_eligible(text,text)', 'billing_seat_refresh_org(text)',
    'billing_seat_refresh_change()']
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I',
      function_signature, current_schema());
  END LOOP;
END $$;
