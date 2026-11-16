BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Retirement is a soft delete: a retired version can no longer be given to anybody, while every
-- record that already names it keeps resolving it. Neither column is a commercial term, so the
-- immutability trigger (which compares only terms) lets an UPDATE of just these two through.
ALTER TABLE billing_tariffs ADD COLUMN retired_at timestamptz(3), ADD COLUMN retired_by_email varchar(200);
ALTER TABLE billing_tariffs
  ADD CONSTRAINT billing_tariffs_default_not_retired CHECK (NOT is_default OR retired_at IS NULL),
  ADD CONSTRAINT billing_tariffs_retirement_actor CHECK ((retired_at IS NULL) = (retired_by_email IS NULL));

-- The regional fallback picks a tariff for new seat business, so it skips retired versions exactly
-- as the API's `standard-<currency>` lookup does. Body otherwise unchanged from
-- 20261115160000_invitation_payment_admission.
CREATE OR REPLACE FUNCTION billing_nessie_paid_seat_scope(p_org text,p_team text)
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
        AND t.retired_at IS NULL
        AND ((region_currency IS NULL AND t.is_default) OR
          (region_currency IS NOT NULL AND t.key='standard-'||lower(region_currency) AND t.currency=region_currency))
      ORDER BY t.version DESC LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'A billing manager must complete billing setup' USING ERRCODE='PZ002'; END IF;
  END IF;
  IF selected.anniversary_seats THEN RETURN QUERY SELECT selected.id,selected.selected_team; END IF;
END;
$$;

-- CREATE OR REPLACE resets the function's SET options; restore the original hardening.
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',
    'billing_nessie_paid_seat_scope(text,text)',current_schema());
  EXECUTE format('ALTER FUNCTION %s SET timezone=%L','billing_nessie_paid_seat_scope(text,text)','UTC');
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC','billing_nessie_paid_seat_scope(text,text)');
END;
$$;
COMMIT;
