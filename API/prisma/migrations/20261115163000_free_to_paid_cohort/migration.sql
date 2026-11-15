BEGIN;
-- One organisation allowance. Resolve its start from the effective paid scope,
-- including a team moving off a free agreement; never from a later login.
CREATE OR REPLACE FUNCTION billing_nessie_start_transition(p_org text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE start_at timestamptz;
BEGIN
  PERFORM billing_seat_touch_org(p_org);
  IF EXISTS(SELECT 1 FROM billing_nessie_seat_transitions WHERE org_id=p_org) THEN RETURN; END IF;
  WITH scopes AS (
    SELECT selected.* FROM billing_nessie_paid_seat_scope(p_org,NULL) selected
    UNION
    SELECT selected.* FROM teams team CROSS JOIN LATERAL billing_nessie_paid_seat_scope(p_org,team.id) selected
      WHERE team.org_id=p_org AND team.lifecycle_status='ACTIVE'
  ), starts AS (
    SELECT CASE WHEN term.id IS NOT NULL AND (prior.monthly_amount_minor=0 OR prior.mode='FREE' OR o.created_at<c.applied_at)
      THEN GREATEST(o.created_at,term.created_at,to_date(term.effective_from_month||'-01','YYYY-MM-DD')::timestamptz)
      ELSE GREATEST(o.created_at,c.applied_at) END AS starts_at
    FROM scopes selected CROSS JOIN organisations o CROSS JOIN billing_nessie_admission_cutover c
    LEFT JOIN LATERAL (
      SELECT e.* FROM billing_tariff_term_events e JOIN billing_services svc ON svc.id=e.service_id AND svc.identifier='nessie'
      WHERE e.source=CASE WHEN selected.team_id IS NULL THEN 'ORGANISATION'::"BillingTariffSource" ELSE 'TEAM'::"BillingTariffSource" END
        AND e.scope_key=CASE WHEN selected.team_id IS NULL THEN p_org ELSE p_org||':'||selected.team_id END
        AND e.effective_from_month<=to_char(now(),'YYYY-MM') AND (e.tariff_id=selected.tariff_id OR e.tariff_id IS NULL)
      ORDER BY e.effective_from_month DESC,e.sequence DESC LIMIT 1
    ) term ON true
    LEFT JOIN LATERAL (
      SELECT tariff.monthly_amount_minor,tariff.mode FROM billing_tariff_term_events e
      JOIN billing_tariffs tariff ON tariff.id=e.tariff_id
      WHERE e.service_id=term.service_id AND e.effective_from_month<=term.effective_from_month
        AND ((e.source=term.source AND e.scope_key=term.scope_key
          AND (e.effective_from_month,e.sequence)<(term.effective_from_month,term.sequence))
          OR (term.source='TEAM' AND e.source='ORGANISATION' AND e.scope_key=p_org AND e.sequence<term.sequence))
      ORDER BY (e.source=term.source) DESC,e.effective_from_month DESC,e.sequence DESC LIMIT 1
    ) prior ON true
    WHERE o.id=p_org
  ) SELECT min(starts_at) INTO start_at FROM starts;
  IF start_at IS NULL THEN RETURN; END IF;
  INSERT INTO billing_nessie_seat_transitions(org_id,starts_at,ends_at,cohort_user_ids)
    VALUES(p_org,start_at,start_at+interval '336 hours',
      ARRAY(SELECT DISTINCT user_id FROM (
        SELECT e.user_id FROM billing_seat_eligible(p_org,NULL) e
        UNION SELECT owner_id FROM organisations WHERE id=p_org) members ORDER BY user_id));
END;
$$;

-- A scheduled transition can become due while nobody is logged in. Capture the
-- roster before its first subsequent change, including changes in a free team.
CREATE FUNCTION billing_nessie_capture_member_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE target_org text;
BEGIN
  IF TG_TABLE_NAME='org_members' THEN target_org:=COALESCE(NEW.org_id,OLD.org_id);
  ELSE SELECT org_id INTO target_org FROM teams WHERE id=COALESCE(NEW.team_id,OLD.team_id); END IF;
  -- Initial identity bootstrap precedes the product's billing enrollment.
  IF TG_TABLE_NAME='org_members' AND TG_OP='INSERT'
    AND NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=target_org) THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM billing_services svc JOIN billing_tariffs tariff ON tariff.service_id=svc.id
    WHERE svc.identifier='nessie' AND tariff.anniversary_seats) THEN
    PERFORM billing_nessie_start_transition(target_org);
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_00_nessie_member_cohort BEFORE INSERT OR UPDATE OR DELETE ON org_members
  FOR EACH ROW EXECUTE FUNCTION billing_nessie_capture_member_transition();
CREATE TRIGGER billing_00_nessie_team_cohort BEFORE INSERT OR UPDATE OR DELETE ON team_members
  FOR EACH ROW EXECUTE FUNCTION billing_nessie_capture_member_transition();

CREATE FUNCTION billing_nessie_capture_term_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE target_org text;
BEGIN
  IF NEW.source='SERVICE_DEFAULT' OR NEW.effective_from_month>to_char(now(),'YYYY-MM')
    OR NOT EXISTS(SELECT 1 FROM billing_services WHERE id=NEW.service_id AND identifier='nessie') THEN RETURN NEW; END IF;
  IF NEW.source='ORGANISATION' THEN SELECT id INTO target_org FROM organisations WHERE id=NEW.scope_key;
  ELSE SELECT org_id INTO target_org FROM teams WHERE org_id||':'||id=NEW.scope_key; END IF;
  IF target_org IS NOT NULL THEN PERFORM billing_nessie_start_transition(target_org); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_nessie_term_cohort AFTER INSERT ON billing_tariff_term_events
  FOR EACH ROW EXECUTE FUNCTION billing_nessie_capture_term_transition();
DO $$ DECLARE signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['billing_nessie_start_transition(text)',
    'billing_nessie_capture_member_transition()','billing_nessie_capture_term_transition()'] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',signature,current_schema());
    EXECUTE format('ALTER FUNCTION %s SET timezone=%L',signature,'UTC');
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,uoa_app',signature);
  END LOOP;
END; $$;
GRANT EXECUTE ON FUNCTION billing_nessie_start_transition(text) TO uoa_admin;
COMMIT;
