BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION billing_invitation_seat_ready(p_invite text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE invitation team_invites; root team_invites;
BEGIN
  SELECT * INTO invitation FROM team_invites WHERE id=p_invite;
  IF NOT FOUND THEN RETURN false; END IF;
  IF invitation.accepted_at IS NOT NULL OR invitation.declined_at IS NOT NULL OR invitation.revoked_at IS NOT NULL
    OR invitation.approval_status NOT IN ('APPROVED','NOT_REQUIRED')
    OR invitation.expires_at<=now() THEN RETURN false; END IF;
  IF (session_user='uoa_app' OR current_setting('role',true)='uoa_app')
    AND nullif(current_setting('app.org_id',true),'') IS DISTINCT FROM invitation.org_id THEN RETURN false; END IF;
  IF NOT invitation.billing_seat_required THEN RETURN true; END IF;
  -- The captured flag is history; an effective seat-free agreement needs no collection.
  IF NOT EXISTS(SELECT 1 FROM billing_nessie_paid_seat_scope(invitation.org_id,invitation.team_id)) THEN
    RETURN true;
  END IF;
  SELECT * INTO root FROM team_invites WHERE id=COALESCE(invitation.billing_seat_source_invite_id,invitation.id);
  RETURN root.billing_seat_funded_at IS NOT NULL AND root.billing_seat_ended_at IS NULL
    AND EXISTS(SELECT 1 FROM billing_seat_subscriptions s JOIN billing_stripe_subscriptions b ON b.id=s.stripe_subscription_id
      WHERE s.id=root.billing_seat_subscription_id AND s.ended_at IS NULL AND billing_nessie_subscription_paid_now(b.id,now()));
END;
$$;
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION billing_invitation_seat_ready(text) SET search_path=pg_catalog,%I,pg_temp',current_schema());
END;
$$;
ALTER FUNCTION billing_invitation_seat_ready(text) SET timezone='UTC';
REVOKE ALL ON FUNCTION billing_invitation_seat_ready(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_invitation_seat_ready(text) TO uoa_app,uoa_admin;
COMMIT;
