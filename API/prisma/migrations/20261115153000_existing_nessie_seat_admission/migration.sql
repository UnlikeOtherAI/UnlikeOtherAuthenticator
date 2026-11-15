BEGIN;
CREATE OR REPLACE FUNCTION billing_anniversary_admission() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE target_org text; target_team text; subject text; selected record; region_currency text;
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
  -- Existing as well as new Nessie organisations must establish payment. Registration
  -- remains recognisable during credential rotation; expired keys never grant a bypass.
  IF NOT EXISTS (
    SELECT 1 FROM billing_services svc WHERE svc.identifier='nessie' AND (
      EXISTS(SELECT 1 FROM organisations o JOIN billing_app_keys k ON k.service_id=svc.id
        AND k.actor_issuer='https://'||o.domain AND k.purpose='CUSTOMER_LIFECYCLE' WHERE o.id=target_org)
      OR EXISTS(SELECT 1 FROM billing_service_accesses a WHERE a.service_id=svc.id AND a.org_id=target_org)
      OR EXISTS(SELECT 1 FROM billing_tariff_assignments a WHERE a.service_id=svc.id AND a.org_id=target_org)
    )
  ) THEN RETURN NEW; END IF;
  -- Operator changes can take effect next month. Use the same effective-month history
  -- as the Checkout statement, including removal of a team override.
  WITH effective AS (
    SELECT DISTINCT ON (e.source) e.source,e.tariff_id
    FROM billing_tariff_term_events e JOIN billing_services svc ON svc.id=e.service_id
    WHERE svc.identifier='nessie' AND svc.active
      AND e.effective_from_month<=to_char(now() AT TIME ZONE 'UTC','YYYY-MM')
      AND ((e.source='ORGANISATION' AND e.scope_key=target_org)
        OR (e.source='TEAM' AND e.scope_key=target_org||':'||target_team))
    ORDER BY e.source,e.effective_from_month DESC,e.sequence DESC
  )
  SELECT t.anniversary_seats,t.id AS tariff_id,
      CASE WHEN e.source='TEAM' THEN target_team ELSE NULL END AS team_id INTO selected
    FROM effective e JOIN billing_tariffs t ON t.id=e.tariff_id
    ORDER BY (e.source='TEAM') DESC LIMIT 1;
  IF NOT FOUND THEN
    SELECT currency INTO region_currency FROM billing_organisation_regions WHERE org_id=target_org;
    SELECT t.anniversary_seats,t.id AS tariff_id,NULL::text AS team_id INTO selected
      FROM billing_services svc JOIN billing_tariffs t ON t.service_id=svc.id
        AND ((region_currency IS NULL AND t.is_default) OR
          (region_currency IS NOT NULL AND t.key='standard-'||lower(region_currency) AND t.currency=region_currency))
      WHERE svc.identifier='nessie' AND svc.active AND t.mode='STANDARD' AND t.collection_mode='STRIPE'
        AND t.usage_payment_mode='PREPAID' AND t.monthly_charge_basis='PER_SEAT' AND t.monthly_amount_minor>0
      ORDER BY t.version DESC LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A billing manager must complete the seat payment' USING ERRCODE='PZ002';
    END IF;
  END IF;
  IF NOT selected.anniversary_seats THEN RETURN NEW; END IF;
  PERFORM billing_seat_touch_org(target_org);
  IF NOT EXISTS (SELECT 1 FROM billing_stripe_subscriptions b JOIN billing_seat_subscriptions s
    ON s.stripe_subscription_id=b.id WHERE b.org_id=target_org AND b.team_id IS NOT DISTINCT FROM selected.team_id
    AND b.tariff_id=selected.tariff_id AND b.status='active' AND b.initial_seat_invoice_id IS NOT NULL
    AND s.ended_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM billing_automatic_seat_changes c WHERE c.seat_subscription_id=s.id
      AND c.delta=1 AND c.completed_at IS NULL AND c.failure_code IS NOT NULL
    )) THEN
    RAISE EXCEPTION 'A billing manager must complete the seat payment'
      USING ERRCODE='PZ002', CONSTRAINT='billing_seat_payment_required';
  END IF;
  RETURN NEW;
END;
$$;
COMMIT;
