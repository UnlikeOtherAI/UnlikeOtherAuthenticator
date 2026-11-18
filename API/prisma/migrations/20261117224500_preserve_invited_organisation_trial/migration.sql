BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Drain old invitation writers before repairing the trials they closed.
LOCK TABLE team_invites IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION billing_invitation_seat_requested() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE selected record; root_id text; seat text;
BEGIN
  IF NOT NEW.billing_seat_required OR NEW.approval_status NOT IN ('APPROVED','NOT_REQUIRED')
    OR NEW.accepted_at IS NOT NULL OR NEW.declined_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT * INTO selected FROM billing_nessie_paid_seat_scope(NEW.org_id,NEW.team_id);
  IF NOT FOUND THEN RETURN NEW; END IF;
  PERFORM billing_nessie_start_transition(NEW.org_id);
  root_id:=COALESCE(NEW.billing_seat_source_invite_id,NEW.id);
  SELECT s.id INTO seat FROM billing_seat_subscriptions s JOIN billing_stripe_subscriptions b ON b.id=s.stripe_subscription_id
    WHERE s.org_id=NEW.org_id AND s.team_id IS NOT DISTINCT FROM selected.team_id AND s.tariff_id=selected.tariff_id
      AND s.ended_at IS NULL AND billing_nessie_subscription_paid_now(b.id,now());
  IF seat IS NOT NULL AND NOT EXISTS(SELECT 1 FROM team_invites i WHERE i.id=root_id AND i.billing_seat_funded_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM billing_automatic_seat_changes c WHERE c.invite_id=root_id AND c.delta=1)
    AND NOT EXISTS(SELECT 1 FROM billing_stripe_subscriptions b JOIN billing_stripe_checkout_sessions c ON c.id=b.checkout_id
      WHERE b.id=(SELECT stripe_subscription_id FROM billing_seat_subscriptions WHERE id=seat) AND root_id=ANY(c.initial_seat_invites)) THEN
    PERFORM billing_enqueue_invitation_seat(seat,root_id,1,clock_timestamp() AT TIME ZONE 'UTC');
  END IF;
  RETURN NEW;
END;
$$;
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION billing_invitation_seat_requested() SET search_path=pg_catalog,%I,pg_temp',current_schema());
END;
$$;
ALTER FUNCTION billing_invitation_seat_requested() SET timezone='UTC';

-- The invitation trigger was the sole writer of ended_at. Restore only the
-- remaining time on early closures. The stored roster and deadline stay fixed.
ALTER TABLE billing_nessie_seat_transitions DISABLE TRIGGER billing_nessie_transition_immutable;
UPDATE billing_nessie_seat_transitions SET ended_at=NULL
  WHERE ended_at < ends_at AND ends_at > now();
ALTER TABLE billing_nessie_seat_transitions ENABLE TRIGGER billing_nessie_transition_immutable;
COMMIT;
