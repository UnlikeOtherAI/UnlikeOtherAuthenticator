BEGIN;
ALTER TABLE team_invites
  ADD COLUMN billing_seat_required boolean NOT NULL DEFAULT false,
  ADD COLUMN billing_seat_source_invite_id text REFERENCES team_invites(id) ON DELETE RESTRICT,
  ADD COLUMN billing_seat_subscription_id text REFERENCES billing_seat_subscriptions(id) ON DELETE RESTRICT,
  ADD COLUMN billing_seat_funded_at timestamptz(3),
  ADD COLUMN billing_seat_ended_at timestamptz(3),
  ADD CONSTRAINT invitation_seat_funding_pair CHECK
    (billing_seat_funded_at IS NULL OR billing_seat_subscription_id IS NOT NULL);
CREATE INDEX team_invites_billing_seat_source_idx ON team_invites(billing_seat_source_invite_id);
ALTER TABLE billing_stripe_checkout_sessions ADD COLUMN initial_seat_invites text[] NOT NULL DEFAULT '{}';
ALTER TABLE billing_automatic_seat_changes ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN invite_id text REFERENCES team_invites(id) ON DELETE RESTRICT,
  ADD COLUMN cancelled_without_charge boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT seat_change_subject CHECK(user_id IS NOT NULL OR invite_id IS NOT NULL);
CREATE UNIQUE INDEX billing_invitation_seat_addition_once
  ON billing_automatic_seat_changes(seat_subscription_id,invite_id) WHERE delta=1 AND invite_id IS NOT NULL;

CREATE OR REPLACE FUNCTION billing_guard_automatic_seat_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Automatic seat operation evidence is immutable' USING ERRCODE='23514'; END IF;
  IF (OLD.id,OLD.seat_subscription_id,OLD.user_id,OLD.invite_id,OLD.delta,OLD.from_quantity,OLD.to_quantity,OLD.effective_at)
    IS DISTINCT FROM (NEW.id,NEW.seat_subscription_id,NEW.user_id,NEW.invite_id,NEW.delta,NEW.from_quantity,NEW.to_quantity,NEW.effective_at)
    OR (OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Automatic seat operation evidence is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.cancelled_without_charge AND (NEW.stripe_invoice_id IS NOT NULL OR OLD.first_attempt_at IS NOT NULL) THEN
    RAISE EXCEPTION 'An attempted seat payment must be reconciled' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION billing_enqueue_invitation_seat(p_seat text,p_invite text,p_delta integer,p_at timestamp)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE previous integer;
BEGIN
  SELECT to_quantity INTO previous FROM billing_automatic_seat_changes
    WHERE seat_subscription_id=p_seat ORDER BY id DESC LIMIT 1;
  IF previous IS NULL THEN
    SELECT cardinality(c.initial_seat_members)+cardinality(c.initial_seat_invites) INTO STRICT previous
      FROM billing_seat_subscriptions s JOIN billing_stripe_subscriptions b ON b.id=s.stripe_subscription_id
      JOIN billing_stripe_checkout_sessions c ON c.id=b.checkout_id WHERE s.id=p_seat;
  END IF;
  INSERT INTO billing_automatic_seat_changes(seat_subscription_id,invite_id,delta,from_quantity,to_quantity,effective_at)
    VALUES(p_seat,p_invite,p_delta,previous,previous+p_delta,p_at);
END;
$$;

CREATE OR REPLACE FUNCTION billing_enqueue_seat_change(p_seat text,p_user text,p_delta integer,p_at timestamp)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE previous integer;
BEGIN
  SELECT to_quantity INTO previous FROM billing_automatic_seat_changes
    WHERE seat_subscription_id=p_seat ORDER BY id DESC LIMIT 1;
  IF previous IS NULL THEN
    SELECT cardinality(c.initial_seat_members)+cardinality(c.initial_seat_invites) INTO STRICT previous
      FROM billing_seat_subscriptions s JOIN billing_stripe_subscriptions b ON b.id=s.stripe_subscription_id
      JOIN billing_stripe_checkout_sessions c ON c.id=b.checkout_id WHERE s.id=p_seat;
  END IF;
  INSERT INTO billing_automatic_seat_changes(seat_subscription_id,user_id,delta,from_quantity,to_quantity,effective_at)
    VALUES(p_seat,p_user,p_delta,previous,previous+p_delta,p_at);
END;
$$;

CREATE OR REPLACE FUNCTION billing_checkout_seat_snapshot() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.initial_seat_members,NEW.initial_seat_invites) IS DISTINCT FROM (OLD.initial_seat_members,OLD.initial_seat_invites) THEN
      RAISE EXCEPTION 'Checkout seat snapshot is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF EXISTS(SELECT 1 FROM billing_tariffs WHERE id=NEW.tariff_id AND anniversary_seats) THEN
    PERFORM billing_seat_touch_org(NEW.org_id);
    SELECT COALESCE(array_agg(e.user_id ORDER BY e.user_id),'{}') INTO NEW.initial_seat_members
      FROM billing_seat_eligible(NEW.org_id,NEW.team_id) e;
    SELECT COALESCE(array_agg(i.id ORDER BY i.id),'{}') INTO NEW.initial_seat_invites FROM team_invites i
      WHERE i.org_id=NEW.org_id AND (NEW.team_id IS NULL OR i.team_id=NEW.team_id)
        AND i.billing_seat_required AND i.billing_seat_source_invite_id IS NULL
        AND i.billing_seat_ended_at IS NULL AND i.billing_seat_funded_at IS NULL
        AND i.approval_status IN ('APPROVED','NOT_REQUIRED')
        AND (i.revoked_at IS NULL OR i.revoked_reason='REPLACED') AND i.declined_at IS NULL;
    IF cardinality(NEW.initial_seat_members)<1 THEN
      RAISE EXCEPTION 'A paid seat checkout requires active members' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER billing_checkout_seat_snapshot ON billing_stripe_checkout_sessions;
CREATE TRIGGER billing_checkout_seat_snapshot BEFORE INSERT OR UPDATE ON billing_stripe_checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION billing_checkout_seat_snapshot();

CREATE FUNCTION billing_fund_initial_invitations() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE seat text;
BEGIN
  IF NEW.initial_seat_invoice_id IS NULL OR OLD.initial_seat_invoice_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT id INTO STRICT seat FROM billing_seat_subscriptions WHERE stripe_subscription_id=NEW.id AND ended_at IS NULL;
  UPDATE team_invites SET billing_seat_subscription_id=seat,billing_seat_funded_at=clock_timestamp()
    WHERE id IN (SELECT unnest(initial_seat_invites) FROM billing_stripe_checkout_sessions WHERE id=NEW.checkout_id)
      AND org_id=NEW.org_id AND (NEW.team_id IS NULL OR team_id=NEW.team_id)
      AND billing_seat_funded_at IS NULL;
  -- Invites committed while the first webhook was in flight must not remain unqueued.
  UPDATE team_invites SET last_sent_at=last_sent_at WHERE org_id=NEW.org_id
    AND (NEW.team_id IS NULL OR team_id=NEW.team_id) AND billing_seat_required
    AND billing_seat_funded_at IS NULL AND billing_seat_ended_at IS NULL
    AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_fund_initial_invitations AFTER UPDATE OF initial_seat_invoice_id ON billing_stripe_subscriptions
  FOR EACH ROW EXECUTE FUNCTION billing_fund_initial_invitations();

CREATE FUNCTION billing_fund_additional_invitation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.invite_id IS NOT NULL AND NEW.delta=1 AND NEW.completed_at IS NOT NULL AND OLD.completed_at IS NULL
    AND NOT NEW.cancelled_without_charge THEN
    IF NEW.stripe_invoice_id IS NULL THEN
      RAISE EXCEPTION 'Invitation seat requires a collected invoice' USING ERRCODE='23514';
    END IF;
    UPDATE team_invites SET billing_seat_subscription_id=NEW.seat_subscription_id,billing_seat_funded_at=NEW.completed_at
      WHERE id=NEW.invite_id AND billing_seat_funded_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_fund_additional_invitation AFTER UPDATE OF completed_at ON billing_automatic_seat_changes
  FOR EACH ROW EXECUTE FUNCTION billing_fund_additional_invitation();

DO $$
DECLARE signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['billing_enqueue_invitation_seat(text,text,integer,timestamp)',
    'billing_fund_initial_invitations()','billing_fund_additional_invitation()']
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',signature,current_schema());
    EXECUTE format('ALTER FUNCTION %s SET timezone=%L',signature,'UTC');
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  END LOOP;
END;
$$;
COMMIT;
