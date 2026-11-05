-- Keep both Stripe source line references when a positive seat proration nets two quantity lines.
ALTER TABLE billing_stripe_payment_invoice_lines ADD COLUMN offset_stripe_line_id varchar(255),
  ADD COLUMN carried_from_stripe_invoice_id varchar(255);

-- Existing tariff versions retain their original collection terms.
ALTER TABLE billing_tariffs ADD COLUMN anniversary_seats BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE billing_tariffs ADD CONSTRAINT billing_tariffs_anniversary_seats_check CHECK (
  NOT anniversary_seats OR (
    collection_mode = 'STRIPE' AND monthly_charge_basis = 'PER_SEAT' AND monthly_amount_minor > 0
    AND seat_policy = 'AUTOMATIC' AND seat_charge_timing = 'PRORATED'
    AND (usage_payment_mode = 'PREPAID' OR mode = 'FREE')
  )
);
CREATE FUNCTION billing_guard_anniversary_tariff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.anniversary_seats IS DISTINCT FROM NEW.anniversary_seats THEN
    RAISE EXCEPTION 'Create a new tariff version to change seat collection' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_anniversary_tariff_immutable BEFORE UPDATE OF anniversary_seats ON billing_tariffs
  FOR EACH ROW EXECUTE FUNCTION billing_guard_anniversary_tariff();

ALTER TABLE billing_stripe_checkout_sessions ADD COLUMN initial_seat_members text[] NOT NULL DEFAULT '{}';
CREATE FUNCTION billing_checkout_seat_snapshot() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.initial_seat_members IS DISTINCT FROM OLD.initial_seat_members THEN
      RAISE EXCEPTION 'Checkout seat snapshot is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM billing_tariffs WHERE id = NEW.tariff_id AND anniversary_seats) THEN
    PERFORM billing_seat_touch_org(NEW.org_id);
    SELECT array_agg(e.user_id ORDER BY e.user_id) INTO NEW.initial_seat_members
      FROM billing_seat_eligible(NEW.org_id, NEW.team_id) e;
    IF COALESCE(cardinality(NEW.initial_seat_members), 0) < 1 THEN
      RAISE EXCEPTION 'A paid seat checkout requires active members' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_checkout_seat_snapshot BEFORE INSERT OR UPDATE OF initial_seat_members
  ON billing_stripe_checkout_sessions FOR EACH ROW EXECUTE FUNCTION billing_checkout_seat_snapshot();

CREATE TABLE billing_automatic_seat_changes (
  id bigserial PRIMARY KEY,
  seat_subscription_id text NOT NULL REFERENCES billing_seat_subscriptions(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  delta integer NOT NULL CHECK (delta IN (1, -1)),
  from_quantity integer NOT NULL CHECK (from_quantity >= 0),
  to_quantity integer NOT NULL CHECK (to_quantity >= 0 AND to_quantity = from_quantity + delta),
  effective_at timestamp(3) NOT NULL,
  completed_at timestamp(3),
  next_attempt_at timestamp(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
  stripe_invoice_id text,
  first_attempt_at timestamp(3),
  attempt_version integer NOT NULL DEFAULT 1 CHECK (attempt_version > 0),
  failure_code text
);
CREATE INDEX billing_automatic_seat_changes_seat_subscription_id_id_idx ON billing_automatic_seat_changes(seat_subscription_id,id);
CREATE INDEX billing_automatic_seat_due_idx ON billing_automatic_seat_changes(next_attempt_at,id) WHERE completed_at IS NULL;

-- The membership trigger already serializes all writers to an organisation. Keep additions and
-- removals separate, including a replacement that leaves the same number of people on the roster.
CREATE FUNCTION billing_enqueue_seat_change(p_seat text,p_user text,p_delta integer,p_at timestamp) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE previous integer;
BEGIN
  SELECT to_quantity INTO previous FROM billing_automatic_seat_changes
    WHERE seat_subscription_id=p_seat ORDER BY id DESC LIMIT 1;
  IF previous IS NULL THEN
    SELECT cardinality(c.initial_seat_members) INTO STRICT previous FROM billing_seat_subscriptions s
      JOIN billing_stripe_subscriptions b ON b.id=s.stripe_subscription_id
      JOIN billing_stripe_checkout_sessions c ON c.id=b.checkout_id WHERE s.id=p_seat;
  END IF;
  INSERT INTO billing_automatic_seat_changes(seat_subscription_id,user_id,delta,from_quantity,to_quantity,effective_at)
    VALUES(p_seat,p_user,p_delta,previous,previous+p_delta,p_at);
END;
$$;

CREATE FUNCTION billing_anniversary_interval_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE initial_members text[];
BEGIN
  SELECT c.initial_seat_members INTO initial_members FROM billing_seat_subscriptions s
    JOIN billing_tariffs t ON t.id=s.tariff_id AND t.anniversary_seats
    JOIN billing_stripe_subscriptions b ON b.id=s.stripe_subscription_id
    JOIN billing_stripe_checkout_sessions c ON c.id=b.checkout_id
    WHERE s.id=NEW.seat_subscription_id AND s.ended_at IS NULL;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    IF NOT NEW.baseline OR NOT (NEW.user_id=ANY(initial_members)) THEN
      PERFORM billing_enqueue_seat_change(NEW.seat_subscription_id,NEW.user_id,1,NEW.starts_at);
    END IF;
  ELSIF NEW.ends_at IS DISTINCT FROM OLD.ends_at THEN
    IF NEW.ends_at IS NULL THEN
      PERFORM billing_enqueue_seat_change(NEW.seat_subscription_id,NEW.user_id,1,OLD.ends_at);
    ELSE
      PERFORM billing_enqueue_seat_change(NEW.seat_subscription_id,NEW.user_id,-1,NEW.ends_at);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_automatic_seat_interval AFTER INSERT OR UPDATE OF ends_at ON billing_seat_membership_intervals
  FOR EACH ROW EXECUTE FUNCTION billing_anniversary_interval_change();

-- Someone removed while Checkout was open was included in the first payment. Lower renewal
-- quantity without a refund. New members are captured by the baseline interval trigger above.
CREATE FUNCTION billing_anniversary_checkout_removals() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE departed text;
BEGIN
  FOR departed IN SELECT unnest(c.initial_seat_members) FROM billing_stripe_subscriptions b
    JOIN billing_stripe_checkout_sessions c ON c.id=b.checkout_id WHERE b.id=NEW.stripe_subscription_id
    EXCEPT SELECT e.user_id FROM billing_seat_eligible(NEW.org_id,NEW.team_id) e
  LOOP
    PERFORM billing_enqueue_seat_change(NEW.id,departed,-1,NEW.activated_at);
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_anniversary_checkout_removals AFTER INSERT ON billing_seat_subscriptions
  FOR EACH ROW EXECUTE FUNCTION billing_anniversary_checkout_removals();

ALTER TABLE billing_automatic_seat_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_automatic_seat_changes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_automatic_seat_changes FROM PUBLIC,uoa_app;
REVOKE ALL ON SEQUENCE billing_automatic_seat_changes_id_seq FROM PUBLIC,uoa_app;
GRANT SELECT,INSERT,UPDATE ON billing_automatic_seat_changes TO uoa_admin;
GRANT USAGE,SELECT ON SEQUENCE billing_automatic_seat_changes_id_seq TO uoa_admin;

CREATE FUNCTION billing_pending_product_seats(p_org text,p_user text,p_domain text) RETURNS TABLE(team_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM billing_app_keys k JOIN billing_services s ON s.id=k.service_id
    WHERE s.identifier='nessie' AND s.active AND k.purpose='CUSTOMER_LIFECYCLE' AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at>now()) AND k.actor_issuer='https://'||p_domain) THEN RETURN; END IF;
  IF (session_user='uoa_app' OR current_setting('role',true)='uoa_app') AND (
    nullif(current_setting('app.user_id',true),'') IS DISTINCT FROM p_user OR
    nullif(current_setting('app.domain',true),'') IS DISTINCT FROM p_domain OR
    (nullif(current_setting('app.org_id',true),'') IS NOT NULL AND current_setting('app.org_id',true)<>p_org)
  ) THEN RETURN QUERY SELECT NULL::text; RETURN; END IF;
  RETURN QUERY SELECT DISTINCT s.team_id FROM billing_automatic_seat_changes c
    JOIN billing_seat_subscriptions s ON s.id=c.seat_subscription_id
    JOIN billing_services svc ON svc.id=s.service_id AND svc.identifier='nessie'
    WHERE c.user_id=p_user AND c.delta=1 AND c.completed_at IS NULL AND s.org_id=p_org AND s.ended_at IS NULL;
END;
$$;

-- Match the selected explicit agreement. Inviting consumes no seat. An unpaid setup or an
-- outstanding seat invoice must be resolved before another invitation or roster addition.
CREATE FUNCTION billing_anniversary_admission() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE target_org text; target_team text; subject text; selected record;
BEGIN
  IF TG_TABLE_NAME='team_invites' THEN
    IF NEW.declined_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN RETURN NEW; END IF;
    target_org:=NEW.org_id; target_team:=NEW.team_id;
  ELSIF TG_TABLE_NAME='org_members' THEN
    IF NEW.status <> 'ACTIVE' OR (TG_OP='UPDATE' AND OLD.status='ACTIVE') THEN RETURN NEW; END IF;
    target_org:=NEW.org_id; subject:=NEW.user_id;
  ELSE
    IF NEW.status <> 'ACTIVE' OR (TG_OP='UPDATE' AND OLD.status='ACTIVE') THEN RETURN NEW; END IF;
    SELECT t.org_id INTO target_org FROM teams t WHERE t.id=NEW.team_id;
    target_team:=NEW.team_id; subject:=NEW.user_id;
  END IF;
  IF subject IS NOT NULL AND EXISTS(SELECT 1 FROM organisations WHERE id=target_org AND owner_id=subject) THEN RETURN NEW; END IF;
  SELECT t.anniversary_seats, a.tariff_id, a.team_id INTO selected
    FROM billing_tariff_assignments a JOIN billing_tariffs t ON t.id=a.tariff_id
    JOIN billing_services svc ON svc.id=a.service_id AND svc.identifier='nessie' AND svc.active
    WHERE a.org_id=target_org AND (a.team_id IS NULL OR a.team_id=target_team)
    ORDER BY a.team_id NULLS LAST LIMIT 1;
  IF NOT FOUND THEN
    -- A newly onboarded organisation must also choose its billing region before inviting.
    -- Existing organisations, other products and explicit agreements keep their own terms.
    IF EXISTS (SELECT 1 FROM organisations o JOIN billing_services svc ON svc.identifier='nessie' AND svc.active
      JOIN billing_app_keys k ON k.service_id=svc.id AND k.actor_issuer='https://'||o.domain
      JOIN billing_tariffs t ON t.service_id=svc.id AND t.anniversary_seats AND t.mode='STANDARD'
        AND t.key IN ('standard-eur','standard-usd','standard-gbp') AND t.created_at<=o.created_at
      WHERE o.id=target_org AND k.purpose='CUSTOMER_LIFECYCLE' AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at>now())
        AND NOT EXISTS(SELECT 1 FROM billing_organisation_regions r WHERE r.org_id=o.id)
        AND NOT EXISTS(SELECT 1 FROM billing_tariff_assignments a WHERE a.org_id=o.id AND a.service_id=svc.id)
        AND NOT EXISTS(SELECT 1 FROM billing_organisation_contracts h WHERE h.org_id=o.id AND h.status='ACTIVE')
    ) THEN RAISE EXCEPTION 'Choose the billing region and complete the seat payment' USING ERRCODE='PZ002'; END IF;
    RETURN NEW;
  END IF;
  IF NOT selected.anniversary_seats THEN RETURN NEW; END IF;
  PERFORM billing_seat_touch_org(target_org);
  IF NOT EXISTS (SELECT 1 FROM billing_stripe_subscriptions b JOIN billing_seat_subscriptions s
    ON s.stripe_subscription_id=b.id WHERE b.org_id=target_org AND b.team_id IS NOT DISTINCT FROM selected.team_id
    AND b.tariff_id=selected.tariff_id AND b.status='active' AND s.ended_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM billing_automatic_seat_changes c WHERE c.seat_subscription_id=s.id
      AND c.delta=1 AND c.completed_at IS NULL AND c.failure_code IS NOT NULL
    )) THEN
    RAISE EXCEPTION 'A billing manager must complete the seat payment'
      USING ERRCODE='PZ002', CONSTRAINT='billing_seat_payment_required';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_anniversary_invite_payment BEFORE INSERT OR UPDATE OF accepted_at,last_sent_at ON team_invites
  FOR EACH ROW EXECUTE FUNCTION billing_anniversary_admission();
CREATE TRIGGER billing_anniversary_org_payment BEFORE INSERT OR UPDATE OF status ON org_members
  FOR EACH ROW EXECUTE FUNCTION billing_anniversary_admission();
CREATE TRIGGER billing_anniversary_team_payment BEFORE INSERT OR UPDATE OF status ON team_members
  FOR EACH ROW EXECUTE FUNCTION billing_anniversary_admission();

DO $$
DECLARE signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['billing_checkout_seat_snapshot()', 'billing_anniversary_interval_change()',
    'billing_anniversary_checkout_removals()', 'billing_anniversary_admission()', 'billing_pending_product_seats(text,text,text)',
    'billing_enqueue_seat_change(text,text,integer,timestamp)']
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',signature,current_schema());
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION billing_pending_product_seats(text,text,text) TO uoa_app,uoa_admin;
