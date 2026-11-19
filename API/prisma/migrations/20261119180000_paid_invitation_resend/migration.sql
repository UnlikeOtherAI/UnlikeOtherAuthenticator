BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

ALTER TABLE team_invites ADD COLUMN resend_of_id text REFERENCES team_invites(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX team_invites_resend_of_key ON team_invites(resend_of_id);

-- Old resends stamped the original revocation and replacement last_sent_at with the
-- same instant. Link only an unambiguous immediate successor in the same team.
WITH matching AS (
  SELECT prior.id AS previous, replacement.id AS successor,
    count(*) OVER (PARTITION BY prior.id) AS successors,
    count(*) OVER (PARTITION BY replacement.id) AS predecessors
  FROM team_invites prior JOIN team_invites replacement
    ON replacement.team_id=prior.team_id AND replacement.org_id=prior.org_id
    AND replacement.email=prior.email AND replacement.last_sent_at=prior.revoked_at
    AND replacement.created_at>=prior.created_at AND replacement.id<>prior.id
  WHERE prior.revoked_reason='REPLACED' AND replacement.revoked_at IS NULL
    AND replacement.accepted_at IS NULL AND replacement.declined_at IS NULL
    AND replacement.expires_at>now()
)
UPDATE team_invites i SET resend_of_id=m.previous FROM matching m
  WHERE i.id=m.successor AND m.successors=1 AND m.predecessors=1;

ALTER TABLE billing_automatic_seat_changes
  ADD COLUMN reuse_invoice text,
  ADD COLUMN reuse_period_end timestamptz,
  ADD CONSTRAINT seat_change_reuse_pair CHECK (
    (reuse_invoice IS NULL)=(reuse_period_end IS NULL)
    AND (reuse_invoice IS NULL OR (delta=1 AND invite_id IS NOT NULL)));

-- Freeze the operation before any Stripe write, so retrying an idempotency key
-- always uses the same proration policy. Roster removal and deliberate revocation
-- remain distinct from releasing an unaccepted seat when its email link expires.
CREATE FUNCTION billing_bind_expired_invitation_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.reuse_invoice,NEW.reuse_period_end) IS DISTINCT FROM (OLD.reuse_invoice,OLD.reuse_period_end) THEN
      RAISE EXCEPTION 'Invitation payment binding is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  NEW.reuse_invoice:=NULL;
  NEW.reuse_period_end:=NULL;
  IF NEW.delta<>1 OR NEW.invite_id IS NULL THEN RETURN NEW; END IF;

  SELECT CASE WHEN prior.billing_seat_funded_at>=b.current_period_start
    THEN COALESCE(addition.stripe_invoice_id, initial_invoice.stripe_invoice_id)
    ELSE period_invoice.stripe_invoice_id END, b.current_period_end
    INTO NEW.reuse_invoice,NEW.reuse_period_end
  FROM billing_seat_subscriptions s
    JOIN billing_stripe_subscriptions b ON b.id=s.stripe_subscription_id
    JOIN billing_stripe_payment_invoices initial_invoice ON initial_invoice.id=b.initial_seat_invoice_id
    JOIN team_invites requested ON requested.id=NEW.invite_id AND requested.org_id=s.org_id
    JOIN team_invites prior ON prior.billing_seat_subscription_id=s.id
      AND prior.org_id=requested.org_id AND lower(prior.email)=lower(requested.email)
    JOIN billing_automatic_seat_changes released ON released.invite_id=prior.id
      AND released.seat_subscription_id=s.id AND released.delta=-1 AND NOT released.cancelled_without_charge
    LEFT JOIN billing_automatic_seat_changes addition ON addition.invite_id=prior.id
      AND addition.seat_subscription_id=s.id AND addition.delta=1
    LEFT JOIN LATERAL (SELECT i.stripe_invoice_id FROM billing_seat_payment_periods p
      JOIN billing_stripe_payment_invoices i ON i.id=p.invoice_id
      WHERE p.subscription_id=b.id AND p.starts_at=b.current_period_start AND p.ends_at=b.current_period_end
      ORDER BY i.paid_at LIMIT 1) period_invoice ON true
  WHERE s.id=NEW.seat_subscription_id AND prior.billing_seat_funded_at IS NOT NULL
    AND prior.billing_seat_ended_at>=b.current_period_start AND prior.billing_seat_ended_at<=NEW.effective_at
    AND NEW.effective_at<b.current_period_end AND billing_nessie_subscription_paid_now(b.id,NEW.effective_at)
    AND EXISTS (SELECT 1 FROM team_invites expired
      WHERE (expired.id=prior.id OR expired.billing_seat_source_invite_id=prior.id)
        AND expired.expires_at<=prior.billing_seat_ended_at AND expired.accepted_at IS NULL
        AND expired.declined_at IS NULL AND expired.approval_status IN ('NOT_REQUIRED','APPROVED')
        AND (expired.revoked_at IS NULL OR expired.revoked_at>=prior.billing_seat_ended_at))
  ORDER BY prior.billing_seat_ended_at DESC LIMIT 1;
  RETURN NEW;
END;
$$;
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION billing_bind_expired_invitation_payment() SET search_path=pg_catalog,%I,pg_temp',current_schema());
END; $$;
ALTER FUNCTION billing_bind_expired_invitation_payment() SET timezone='UTC';
REVOKE ALL ON FUNCTION billing_bind_expired_invitation_payment() FROM PUBLIC;
CREATE TRIGGER billing_bind_expired_invitation_payment BEFORE INSERT OR UPDATE OF reuse_invoice,reuse_period_end
ON billing_automatic_seat_changes FOR EACH ROW EXECUTE FUNCTION billing_bind_expired_invitation_payment();
-- During a rolling deployment an older scheduler must never claim a restoration
-- and send its usual always_invoice request. Its claim sees zero returned rows.
CREATE FUNCTION billing_require_invitation_restore_worker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('uoa.invite_restore_aware',true) IS DISTINCT FROM 'yes' THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_require_invitation_restore_worker BEFORE UPDATE OF first_attempt_at
ON billing_automatic_seat_changes FOR EACH ROW WHEN (OLD.reuse_invoice IS NOT NULL AND NEW.first_attempt_at IS NOT NULL)
EXECUTE FUNCTION billing_require_invitation_restore_worker();
COMMIT;
