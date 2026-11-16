BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
-- Commercial periods an operator edits per product. A product without a row uses the defaults in
-- billing_period_setting(), the only reader and the one place those defaults are written.
CREATE TABLE billing_period_settings (
  service_id text PRIMARY KEY REFERENCES billing_services(id) ON DELETE RESTRICT,
  seat_trial_hours integer NOT NULL CHECK(seat_trial_hours BETWEEN 1 AND 8760),
  seat_renewal_grace_hours integer NOT NULL CHECK(seat_renewal_grace_hours BETWEEN 1 AND 720),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_by_user_id text NOT NULL
);
ALTER TABLE billing_period_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_period_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_period_settings FROM PUBLIC,uoa_app;
GRANT SELECT,INSERT,UPDATE ON billing_period_settings TO uoa_admin;

-- One week of free trial; 24 weekday hours to recover a failed seat renewal.
CREATE FUNCTION billing_period_setting(p_service text)
RETURNS TABLE(seat_trial_hours integer,seat_renewal_grace_hours integer) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(s.seat_trial_hours,168),COALESCE(s.seat_renewal_grace_hours,24)
  FROM (VALUES(p_service)) requested(service_id) LEFT JOIN billing_period_settings s USING(service_id)
$$;

-- The trial length is a setting now, so a stored transition keeps whatever length applied when it began.
DO $$ DECLARE fixed text;
BEGIN
  SELECT conname INTO STRICT fixed FROM pg_constraint WHERE conrelid='billing_nessie_seat_transitions'::regclass
    AND contype='c' AND pg_get_constraintdef(oid) LIKE '%336%';
  EXECUTE format('ALTER TABLE billing_nessie_seat_transitions DROP CONSTRAINT %I',fixed);
END; $$;
ALTER TABLE billing_nessie_seat_transitions ADD CONSTRAINT billing_nessie_seat_transitions_period_check CHECK(ends_at>starts_at);

-- One week replaces fourteen days. Every organisation that is still inside its free trial gets that week
-- from now, for the people already in it; organisations yet to be read start theirs from the same instant.
ALTER TABLE billing_nessie_admission_cutover ADD COLUMN trial_reset_at timestamptz(3) NOT NULL DEFAULT clock_timestamp();
ALTER TABLE billing_nessie_seat_transitions DISABLE TRIGGER billing_nessie_transition_immutable;
UPDATE billing_nessie_seat_transitions t SET ends_at=c.trial_reset_at+interval '168 hours'
  FROM billing_nessie_admission_cutover c WHERE t.ended_at IS NULL;
ALTER TABLE billing_nessie_seat_transitions ENABLE TRIGGER billing_nessie_transition_immutable;

CREATE OR REPLACE FUNCTION billing_nessie_start_transition(p_org text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE start_at timestamptz; trial_hours integer;
BEGIN
  PERFORM billing_seat_touch_org(p_org);
  IF EXISTS(SELECT 1 FROM billing_nessie_seat_transitions WHERE org_id=p_org) THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM billing_services svc JOIN billing_tariffs t ON t.service_id=svc.id
    WHERE svc.identifier='nessie' AND svc.active AND t.anniversary_seats) THEN RETURN; END IF;
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
  SELECT p.seat_trial_hours INTO STRICT trial_hours FROM billing_services svc
    CROSS JOIN LATERAL billing_period_setting(svc.id) p WHERE svc.identifier='nessie';
  -- A trial that began before the current trial terms runs its length from when those terms began.
  INSERT INTO billing_nessie_seat_transitions(org_id,starts_at,ends_at,cohort_user_ids)
    VALUES(p_org,start_at,GREATEST(start_at,(SELECT c.trial_reset_at FROM billing_nessie_admission_cutover c))
        +make_interval(hours=>trial_hours),
      ARRAY(SELECT DISTINCT user_id FROM (
        SELECT e.user_id FROM billing_seat_eligible(p_org,NULL) e
        UNION SELECT owner_id FROM organisations WHERE id=p_org) members ORDER BY user_id));
END;
$$;

DO $$ DECLARE signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['billing_nessie_start_transition(text)','billing_period_setting(text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',signature,current_schema());
    EXECUTE format('ALTER FUNCTION %s SET timezone=%L',signature,'UTC');
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,uoa_app',signature);
  END LOOP;
END; $$;
GRANT EXECUTE ON FUNCTION billing_nessie_start_transition(text) TO uoa_admin;
GRANT EXECUTE ON FUNCTION billing_period_setting(text) TO uoa_admin;
COMMIT;
