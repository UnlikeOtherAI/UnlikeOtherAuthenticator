BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
CREATE OR REPLACE FUNCTION billing_anniversary_interval_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE initial_members text[]; funded boolean;
BEGIN
  SELECT c.initial_seat_members INTO initial_members FROM billing_seat_subscriptions s
    JOIN billing_tariffs t ON t.id=s.tariff_id AND t.anniversary_seats
    JOIN billing_stripe_subscriptions b ON b.id=s.stripe_subscription_id
    JOIN billing_stripe_checkout_sessions c ON c.id=b.checkout_id
    WHERE s.id=NEW.seat_subscription_id AND s.ended_at IS NULL;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT EXISTS(SELECT 1 FROM team_invites i JOIN users u ON lower(u.email)=lower(i.email)
    WHERE u.id=NEW.user_id AND i.billing_seat_subscription_id=NEW.seat_subscription_id
      AND i.billing_seat_funded_at IS NOT NULL AND i.billing_seat_ended_at IS NULL) INTO funded;
  IF TG_OP='INSERT' THEN
    IF (NOT NEW.baseline OR NOT (NEW.user_id=ANY(initial_members))) AND NOT funded THEN
      RAISE EXCEPTION 'A new seat requires a paid invitation' USING ERRCODE='PZ002';
    END IF;
  ELSIF NEW.ends_at IS DISTINCT FROM OLD.ends_at THEN
    IF NEW.ends_at IS NULL THEN
      IF NOT funded THEN RAISE EXCEPTION 'A returning seat requires a paid invitation' USING ERRCODE='PZ002'; END IF;
    ELSE
      UPDATE team_invites SET billing_seat_ended_at=NEW.ends_at
        WHERE billing_seat_subscription_id=NEW.seat_subscription_id AND billing_seat_ended_at IS NULL
          AND lower(email)=(SELECT lower(email) FROM users WHERE id=NEW.user_id);
      PERFORM billing_enqueue_seat_change(NEW.seat_subscription_id,NEW.user_id,-1,NEW.ends_at);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION billing_end_invitation_seat(p_root text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE root team_invites; addition billing_automatic_seat_changes; reduction bigint; seat text;
BEGIN
  SELECT * INTO root FROM team_invites WHERE id=p_root;
  IF NOT FOUND OR NOT root.billing_seat_required OR root.billing_seat_ended_at IS NOT NULL THEN RETURN; END IF;
  PERFORM billing_seat_touch_org(root.org_id);
  SELECT * INTO root FROM team_invites WHERE id=p_root FOR UPDATE;
  IF root.billing_seat_ended_at IS NOT NULL THEN RETURN; END IF;
  -- A replacement preserves the same paid seat. An accepted seat is ended by roster removal.
  IF EXISTS(SELECT 1 FROM team_invites i WHERE (i.id=p_root OR i.billing_seat_source_invite_id=p_root)
    AND (i.accepted_at IS NOT NULL OR (i.declined_at IS NULL AND i.revoked_at IS NULL
      AND i.approval_status<>'DENIED' AND (i.expires_at IS NULL OR i.expires_at>now())))) THEN RETURN; END IF;
  UPDATE team_invites SET billing_seat_ended_at=clock_timestamp() WHERE id=p_root;
  SELECT * INTO addition FROM billing_automatic_seat_changes WHERE invite_id=p_root AND delta=1 ORDER BY id DESC LIMIT 1 FOR UPDATE;
  seat:=COALESCE(root.billing_seat_subscription_id,addition.seat_subscription_id);
  IF seat IS NULL THEN RETURN; END IF;
  PERFORM billing_enqueue_invitation_seat(seat,p_root,-1,clock_timestamp() AT TIME ZONE 'UTC');
  SELECT id INTO reduction FROM billing_automatic_seat_changes WHERE invite_id=p_root AND delta=-1 ORDER BY id DESC LIMIT 1;
  -- Only a never-attempted adjacent pair can be removed without provider reconciliation.
  IF addition.id IS NOT NULL AND addition.first_attempt_at IS NULL AND addition.completed_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM billing_automatic_seat_changes c WHERE c.seat_subscription_id=seat
      AND c.id>addition.id AND c.id<reduction) THEN
    UPDATE billing_automatic_seat_changes SET cancelled_without_charge=true,completed_at=clock_timestamp()
      WHERE id IN (addition.id,reduction);
  END IF;
END;
$$;

CREATE FUNCTION billing_invitation_seat_closed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.billing_seat_required AND NEW.accepted_at IS NULL AND
    (NEW.declined_at IS NOT NULL OR (NEW.revoked_at IS NOT NULL AND NEW.revoked_reason IS DISTINCT FROM 'REPLACED')
      OR NEW.approval_status='DENIED') THEN
    PERFORM billing_end_invitation_seat(COALESCE(NEW.billing_seat_source_invite_id,NEW.id));
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_invitation_seat_closed AFTER UPDATE OF declined_at,revoked_at,approval_status ON team_invites
  FOR EACH ROW EXECUTE FUNCTION billing_invitation_seat_closed();

CREATE FUNCTION billing_expire_invitation_seats(p_limit integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE candidate record; processed integer:=0;
BEGIN
  FOR candidate IN SELECT i.id FROM team_invites i WHERE i.billing_seat_required AND i.billing_seat_source_invite_id IS NULL
    AND i.billing_seat_ended_at IS NULL AND i.accepted_at IS NULL AND i.expires_at<=now()
    AND NOT EXISTS(SELECT 1 FROM team_invites replacement WHERE replacement.billing_seat_source_invite_id=i.id
      AND (replacement.accepted_at IS NOT NULL OR (replacement.revoked_at IS NULL AND replacement.declined_at IS NULL
        AND replacement.approval_status<>'DENIED' AND (replacement.expires_at IS NULL OR replacement.expires_at>now()))))
    ORDER BY i.expires_at LIMIT LEAST(GREATEST(p_limit,0),100)
  LOOP
    PERFORM billing_end_invitation_seat(candidate.id); processed:=processed+1;
  END LOOP;
  RETURN processed;
END;
$$;

CREATE OR REPLACE FUNCTION billing_anniversary_checkout_removals() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE departed text; invitation text;
BEGIN
  FOR departed IN SELECT unnest(c.initial_seat_members) FROM billing_stripe_subscriptions b
    JOIN billing_stripe_checkout_sessions c ON c.id=b.checkout_id WHERE b.id=NEW.stripe_subscription_id
    EXCEPT SELECT e.user_id FROM billing_seat_eligible(NEW.org_id,NEW.team_id) e
  LOOP
    PERFORM billing_enqueue_seat_change(NEW.id,departed,-1,NEW.activated_at);
  END LOOP;
  FOR invitation IN SELECT i.id FROM billing_stripe_subscriptions b
    JOIN billing_stripe_checkout_sessions c ON c.id=b.checkout_id
    JOIN team_invites i ON i.id=ANY(c.initial_seat_invites)
    WHERE b.id=NEW.stripe_subscription_id AND i.billing_seat_ended_at IS NOT NULL
  LOOP
    PERFORM billing_enqueue_invitation_seat(NEW.id,invitation,-1,NEW.activated_at);
  END LOOP;
  RETURN NEW;
END;
$$;
DO $$
DECLARE signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['billing_anniversary_interval_change()','billing_end_invitation_seat(text)',
    'billing_invitation_seat_closed()','billing_expire_invitation_seats(integer)','billing_anniversary_checkout_removals()']
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',signature,current_schema());
    EXECUTE format('ALTER FUNCTION %s SET timezone=%L',signature,'UTC');
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION billing_expire_invitation_seats(integer) TO uoa_admin;
COMMIT;
