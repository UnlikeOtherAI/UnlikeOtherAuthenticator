-- Pending fixed-seat Checkout is a capacity claim before external Stripe
-- egress. An unknown or locally abandoned create remains a claim: a late
-- Stripe create can still complete after a lease-based no-match lookup.
CREATE OR REPLACE FUNCTION billing_seat_refresh_org(p_org_id TEXT) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  subscription_row billing_seat_subscriptions%ROWTYPE;
  checkout_row record;
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
      IF subscription_row.ended_at IS NOT NULL OR
         (subscription_row.commercial_ends_at IS NOT NULL AND
          subscription_row.commercial_ends_at <= observed_at) THEN CONTINUE; END IF;
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

  FOR checkout_row IN
    SELECT c.id, c.team_id, c.scope, c.fixed_seat_quantity
    FROM billing_stripe_checkout_sessions c
    LEFT JOIN billing_stripe_subscriptions s ON s.checkout_id = c.id
    LEFT JOIN billing_seat_subscriptions seat ON seat.stripe_subscription_id = s.id
    WHERE c.org_id = p_org_id AND c.fixed_seat_quantity IS NOT NULL
      AND c.status <> 'expired' AND seat.id IS NULL
      AND (s.id IS NULL OR s.status NOT IN ('canceled', 'incomplete_expired'))
    ORDER BY c.id
  LOOP
    scoped_team_id := CASE WHEN checkout_row.scope = 'TEAM'
      THEN checkout_row.team_id ELSE NULL END;
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
    IF occupied + reserved > checkout_row.fixed_seat_quantity THEN
      RAISE EXCEPTION 'Fixed seat checkout capacity exceeded for checkout %', checkout_row.id
        USING ERRCODE = 'PZ001', CONSTRAINT = 'billing_seat_capacity_exceeded';
    END IF;
  END LOOP;
END $$;

-- The existing generic seat trigger functions deliberately enumerate their
-- source tables. Checkout gets narrow trigger functions that handle both old
-- and new orgs and share the same serializing organisation touch.
CREATE FUNCTION billing_seat_touch_checkout_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM billing_seat_touch_org(OLD.org_id); END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.org_id <> OLD.org_id) THEN
    PERFORM billing_seat_touch_org(NEW.org_id);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION billing_seat_refresh_checkout_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM billing_seat_refresh_org(OLD.org_id); END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.org_id <> OLD.org_id) THEN
    PERFORM billing_seat_refresh_org(NEW.org_id);
  END IF;
  RETURN NULL;
END $$;

-- Both pending Checkout creation and membership admission touch the same
-- organisation row before their deferred count. The terminal Stripe status
-- transition rechecks and releases the claim in the same transaction.
CREATE TRIGGER billing_seat_touch
  BEFORE INSERT OR UPDATE OR DELETE ON billing_stripe_checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION billing_seat_touch_checkout_change();
CREATE CONSTRAINT TRIGGER billing_seat_refresh
  AFTER INSERT OR UPDATE OR DELETE ON billing_stripe_checkout_sessions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION billing_seat_refresh_checkout_change();

-- CREATE OR REPLACE clears proconfig; migration 170000 can already have run
-- on deployed databases, so this migration pins the replacement itself.
DO $$
DECLARE function_signature text;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'billing_seat_refresh_org(text)', 'billing_seat_touch_checkout_change()',
    'billing_seat_refresh_checkout_change()']
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, pg_temp',
      function_signature, current_schema());
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', function_signature);
  END LOOP;
END $$;
