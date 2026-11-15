BEGIN;
-- The same scope is used for invitation issuance, direct membership writes and acceptance.
CREATE FUNCTION billing_nessie_paid_seat_scope(p_org text,p_team text)
RETURNS TABLE(tariff_id text,team_id text) LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE selected record; region_currency text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM billing_services svc WHERE svc.identifier='nessie' AND (
    EXISTS(SELECT 1 FROM organisations o JOIN billing_app_keys k ON k.service_id=svc.id
      AND k.actor_issuer='https://'||o.domain AND k.purpose='CUSTOMER_LIFECYCLE' WHERE o.id=p_org)
    OR EXISTS(SELECT 1 FROM billing_service_accesses a WHERE a.service_id=svc.id AND a.org_id=p_org)
    OR EXISTS(SELECT 1 FROM billing_tariff_assignments a WHERE a.service_id=svc.id AND a.org_id=p_org))) THEN RETURN; END IF;
  WITH effective AS (
    SELECT DISTINCT ON(e.source) e.source,e.tariff_id FROM billing_tariff_term_events e
      JOIN billing_services svc ON svc.id=e.service_id AND svc.identifier='nessie' AND svc.active
      WHERE e.effective_from_month<=to_char(now() AT TIME ZONE 'UTC','YYYY-MM')
        AND ((e.source='ORGANISATION' AND e.scope_key=p_org) OR (e.source='TEAM' AND e.scope_key=p_org||':'||p_team))
      ORDER BY e.source,e.effective_from_month DESC,e.sequence DESC
  ) SELECT t.id,t.anniversary_seats,CASE WHEN e.source='TEAM' THEN p_team ELSE NULL END AS selected_team
      INTO selected FROM effective e JOIN billing_tariffs t ON t.id=e.tariff_id ORDER BY (e.source='TEAM') DESC LIMIT 1;
  IF NOT FOUND THEN
    SELECT r.currency INTO region_currency FROM billing_organisation_regions r WHERE r.org_id=p_org;
    SELECT t.id,t.anniversary_seats,NULL::text AS selected_team INTO selected
      FROM billing_services svc JOIN billing_tariffs t ON t.service_id=svc.id
      WHERE svc.identifier='nessie' AND svc.active AND t.anniversary_seats AND t.mode='STANDARD' AND t.collection_mode='STRIPE'
        AND t.usage_payment_mode='PREPAID' AND t.monthly_charge_basis='PER_SEAT' AND t.monthly_amount_minor>0
        AND ((region_currency IS NULL AND t.is_default) OR
          (region_currency IS NOT NULL AND t.key='standard-'||lower(region_currency) AND t.currency=region_currency))
      ORDER BY t.version DESC LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'A billing manager must complete billing setup' USING ERRCODE='PZ002'; END IF;
  END IF;
  IF selected.anniversary_seats THEN RETURN QUERY SELECT selected.id,selected.selected_team; END IF;
END;
$$;

CREATE FUNCTION billing_nessie_start_transition(p_org text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE start_at timestamptz; changed_at timestamptz;
BEGIN
  PERFORM billing_seat_touch_org(p_org);
  IF EXISTS(SELECT 1 FROM billing_nessie_seat_transitions WHERE org_id=p_org) THEN RETURN; END IF;
  SELECT CASE WHEN o.created_at>=c.applied_at THEN o.created_at ELSE clock_timestamp() END INTO STRICT start_at
    FROM organisations o CROSS JOIN billing_nessie_admission_cutover c WHERE o.id=p_org;
  -- Delaying the first login cannot move a previously scheduled free-to-paid transition.
  SELECT GREATEST(e.created_at,to_date(e.effective_from_month||'-01','YYYY-MM-DD')::timestamptz) INTO changed_at
    FROM billing_tariff_term_events e JOIN billing_tariffs t ON t.id=e.tariff_id AND t.anniversary_seats
      JOIN billing_services svc ON svc.id=e.service_id AND svc.identifier='nessie'
    WHERE e.source='ORGANISATION' AND e.scope_key=p_org
      AND e.effective_from_month<=to_char(now(),'YYYY-MM')
    ORDER BY e.effective_from_month DESC,e.sequence DESC LIMIT 1;
  IF changed_at IS NOT NULL AND EXISTS(SELECT 1 FROM organisations o CROSS JOIN billing_nessie_admission_cutover c
    WHERE o.id=p_org AND o.created_at<c.applied_at) THEN start_at:=changed_at; END IF;
  INSERT INTO billing_nessie_seat_transitions(org_id,starts_at,ends_at,cohort_user_ids)
    VALUES(p_org,start_at,start_at+interval '336 hours',
      ARRAY(SELECT DISTINCT user_id FROM (
        SELECT e.user_id FROM billing_seat_eligible(p_org,NULL) e
        UNION SELECT owner_id FROM organisations WHERE id=p_org) members ORDER BY user_id));
END;
$$;

-- Existing unused invitations also require payment. This creates no provider charge.
UPDATE team_invites i SET billing_seat_required=true
WHERE i.accepted_at IS NULL AND i.declined_at IS NULL AND i.revoked_at IS NULL
  AND i.approval_status<>'DENIED'
  AND EXISTS(SELECT 1 FROM billing_nessie_paid_seat_scope(i.org_id,i.team_id) selected
    WHERE NOT EXISTS(SELECT 1 FROM billing_seat_eligible(i.org_id,selected.team_id) e
      JOIN users u ON u.id=e.user_id WHERE lower(u.email)=lower(i.email)));
UPDATE team_invites i SET billing_seat_source_invite_id=(
  SELECT first.id FROM team_invites first
    CROSS JOIN LATERAL billing_nessie_paid_seat_scope(i.org_id,i.team_id) selected
    WHERE first.org_id=i.org_id AND lower(first.email)=lower(i.email) AND first.billing_seat_required
      AND (selected.team_id IS NULL OR first.team_id=selected.team_id)
    ORDER BY first.created_at,first.id LIMIT 1)
  WHERE i.billing_seat_required;
UPDATE team_invites SET billing_seat_source_invite_id=NULL WHERE id=billing_seat_source_invite_id;

-- Tenant callers may change invitation lifecycle fields, never payment evidence.
REVOKE UPDATE ON team_invites FROM uoa_app;
DO $$
DECLARE permitted text;
BEGIN
  SELECT string_agg(quote_ident(column_name),',') INTO permitted FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='team_invites'
      AND column_name NOT LIKE 'billing_seat_%';
  EXECUTE 'GRANT UPDATE ('||permitted||') ON team_invites TO uoa_app';
END;
$$;

CREATE OR REPLACE FUNCTION billing_anniversary_admission() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE target_org text; target_team text; subject text; selected record; root team_invites; paid_seat text;
BEGIN
  IF TG_TABLE_NAME='team_invites' THEN
    target_org:=NEW.org_id; target_team:=NEW.team_id;
  ELSIF TG_TABLE_NAME='org_members' THEN
    IF NEW.status<>'ACTIVE' OR (TG_OP='UPDATE' AND OLD.status='ACTIVE') THEN RETURN NEW; END IF;
    target_org:=NEW.org_id; subject:=NEW.user_id;
  ELSE
    IF NEW.status<>'ACTIVE' OR (TG_OP='UPDATE' AND OLD.status='ACTIVE') THEN RETURN NEW; END IF;
    SELECT t.org_id INTO target_org FROM teams t WHERE t.id=NEW.team_id;
    target_team:=NEW.team_id; subject:=NEW.user_id;
  END IF;
  SELECT * INTO selected FROM billing_nessie_paid_seat_scope(target_org,target_team);
  IF NOT FOUND THEN RETURN NEW; END IF;
  PERFORM billing_seat_touch_org(target_org);
  IF TG_TABLE_NAME='team_invites' THEN
    IF TG_OP='UPDATE' THEN
      IF (NEW.org_id,NEW.team_id,NEW.email,NEW.billing_seat_required,NEW.billing_seat_source_invite_id)
        IS DISTINCT FROM (OLD.org_id,OLD.team_id,OLD.email,OLD.billing_seat_required,OLD.billing_seat_source_invite_id) THEN
        RAISE EXCEPTION 'Invitation payment binding is immutable' USING ERRCODE='23514';
      END IF;
      IF NEW.accepted_at IS DISTINCT FROM OLD.accepted_at AND NEW.billing_seat_required THEN
        SELECT * INTO root FROM team_invites WHERE id=COALESCE(NEW.billing_seat_source_invite_id,NEW.id);
        IF root.billing_seat_funded_at IS NULL OR root.billing_seat_ended_at IS NOT NULL THEN
          RAISE EXCEPTION 'A billing manager must complete the seat payment' USING ERRCODE='PZ002';
        END IF;
      END IF;
      RETURN NEW;
    END IF;
    -- Never accept financial evidence supplied with an invitation request.
    NEW.billing_seat_required:=false; NEW.billing_seat_source_invite_id:=NULL;
    NEW.billing_seat_subscription_id:=NULL; NEW.billing_seat_funded_at:=NULL; NEW.billing_seat_ended_at:=NULL;
    IF EXISTS(SELECT 1 FROM billing_seat_eligible(target_org,selected.team_id) e
      JOIN users u ON u.id=e.user_id WHERE lower(u.email)=lower(NEW.email)) THEN RETURN NEW; END IF;
    NEW.billing_seat_required:=true;
    SELECT i.* INTO root FROM team_invites i WHERE i.org_id=target_org AND lower(i.email)=lower(NEW.email)
      AND (selected.team_id IS NULL OR i.team_id=selected.team_id)
      AND i.billing_seat_required AND i.billing_seat_source_invite_id IS NULL AND i.billing_seat_ended_at IS NULL
      AND i.declined_at IS NULL AND (i.revoked_at IS NULL OR i.revoked_reason='REPLACED')
      AND i.approval_status<>'DENIED' ORDER BY i.created_at LIMIT 1;
    IF FOUND THEN NEW.billing_seat_source_invite_id:=root.id;
    ELSE
      -- A provider Checkout already has an immutable quantity. Finish or expire it before adding another person.
      IF EXISTS(SELECT 1 FROM billing_stripe_checkout_sessions c WHERE c.org_id=target_org
        AND c.status IN ('creating','open') AND (c.expires_at IS NULL OR c.expires_at>now())) THEN
        RAISE EXCEPTION 'Complete the open seat checkout before adding another person' USING ERRCODE='PZ002';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- The creator's first identity membership bootstraps the organisation, not a paid entitlement.
  IF TG_TABLE_NAME='org_members' AND TG_OP='INSERT'
    AND EXISTS(SELECT 1 FROM organisations WHERE id=target_org AND owner_id=subject)
    AND NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=target_org)
    AND NOT EXISTS(SELECT 1 FROM billing_nessie_seat_transitions WHERE org_id=target_org) THEN RETURN NEW; END IF;
  SELECT s.id INTO paid_seat FROM billing_seat_subscriptions s JOIN billing_stripe_subscriptions b ON b.id=s.stripe_subscription_id
    WHERE s.org_id=target_org AND s.team_id IS NOT DISTINCT FROM selected.team_id AND s.tariff_id=selected.tariff_id
      AND s.ended_at IS NULL AND b.status='active' AND b.initial_seat_invoice_id IS NOT NULL;
  IF paid_seat IS NOT NULL AND (
    EXISTS(SELECT 1 FROM billing_seat_membership_intervals i WHERE i.seat_subscription_id=paid_seat AND i.user_id=subject AND i.ends_at IS NULL)
    OR EXISTS(SELECT 1 FROM team_invites i JOIN users u ON lower(u.email)=lower(i.email)
      WHERE u.id=subject AND i.org_id=target_org AND i.billing_seat_subscription_id=paid_seat
        AND i.billing_seat_funded_at IS NOT NULL AND i.billing_seat_ended_at IS NULL
        AND i.declined_at IS NULL AND (i.revoked_at IS NULL OR i.revoked_reason='REPLACED'))
  ) THEN RETURN NEW; END IF;
  PERFORM billing_nessie_start_transition(target_org);
  IF NOT EXISTS(SELECT 1 FROM billing_seat_subscriptions s WHERE s.org_id=target_org AND s.stripe_subscription_id IS NOT NULL)
    AND EXISTS(SELECT 1 FROM billing_nessie_seat_transitions t WHERE t.org_id=target_org
      AND t.ended_at IS NULL AND t.ends_at>now() AND subject=ANY(t.cohort_user_ids)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'A billing manager must complete the seat payment' USING ERRCODE='PZ002';
END;
$$;
DROP TRIGGER billing_anniversary_invite_payment ON team_invites;
CREATE TRIGGER billing_anniversary_invite_payment BEFORE INSERT OR UPDATE ON team_invites
  FOR EACH ROW EXECUTE FUNCTION billing_anniversary_admission();

CREATE FUNCTION billing_invitation_seat_requested() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE selected record; root_id text; seat text;
BEGIN
  IF NOT NEW.billing_seat_required OR NEW.approval_status NOT IN ('APPROVED','NOT_REQUIRED')
    OR NEW.accepted_at IS NOT NULL OR NEW.declined_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT * INTO selected FROM billing_nessie_paid_seat_scope(NEW.org_id,NEW.team_id);
  IF NOT FOUND THEN RETURN NEW; END IF;
  PERFORM billing_nessie_start_transition(NEW.org_id);
  UPDATE billing_nessie_seat_transitions SET ended_at=clock_timestamp() WHERE org_id=NEW.org_id AND ended_at IS NULL;
  root_id:=COALESCE(NEW.billing_seat_source_invite_id,NEW.id);
  SELECT s.id INTO seat FROM billing_seat_subscriptions s JOIN billing_stripe_subscriptions b ON b.id=s.stripe_subscription_id
    WHERE s.org_id=NEW.org_id AND s.team_id IS NOT DISTINCT FROM selected.team_id AND s.tariff_id=selected.tariff_id
      AND s.ended_at IS NULL AND b.status='active' AND b.initial_seat_invoice_id IS NOT NULL;
  IF seat IS NOT NULL AND NOT EXISTS(SELECT 1 FROM team_invites i WHERE i.id=root_id AND i.billing_seat_funded_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM billing_automatic_seat_changes c WHERE c.invite_id=root_id AND c.delta=1)
    AND NOT EXISTS(SELECT 1 FROM billing_stripe_subscriptions b JOIN billing_stripe_checkout_sessions c ON c.id=b.checkout_id
      WHERE b.id=(SELECT stripe_subscription_id FROM billing_seat_subscriptions WHERE id=seat) AND root_id=ANY(c.initial_seat_invites)) THEN
    PERFORM billing_enqueue_invitation_seat(seat,root_id,1,clock_timestamp() AT TIME ZONE 'UTC');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_invitation_seat_requested AFTER INSERT OR UPDATE OF approval_status,last_sent_at ON team_invites
  FOR EACH ROW EXECUTE FUNCTION billing_invitation_seat_requested();

CREATE FUNCTION billing_invitation_seat_ready(p_invite text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
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
  SELECT * INTO root FROM team_invites WHERE id=COALESCE(invitation.billing_seat_source_invite_id,invitation.id);
  RETURN root.billing_seat_funded_at IS NOT NULL AND root.billing_seat_ended_at IS NULL
    AND EXISTS(SELECT 1 FROM billing_seat_subscriptions s JOIN billing_stripe_subscriptions b ON b.id=s.stripe_subscription_id
      WHERE s.id=root.billing_seat_subscription_id AND s.ended_at IS NULL AND b.status='active' AND b.initial_seat_invoice_id IS NOT NULL);
END;
$$;
DO $$
DECLARE signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['billing_nessie_paid_seat_scope(text,text)','billing_nessie_start_transition(text)',
    'billing_anniversary_admission()','billing_invitation_seat_requested()','billing_invitation_seat_ready(text)']
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',signature,current_schema());
    EXECUTE format('ALTER FUNCTION %s SET timezone=%L',signature,'UTC');
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION billing_invitation_seat_ready(text) TO uoa_app,uoa_admin;
GRANT EXECUTE ON FUNCTION billing_nessie_start_transition(text) TO uoa_admin;
COMMIT;
