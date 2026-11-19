BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- A completed checkout alone is insufficient: initial_seat_invoice_id is written
-- only after the invoice and its collected cash have passed the payment guard.
CREATE FUNCTION billing_first_paid_nessie_plan(p_org text)
RETURNS TABLE(tariff_id text,currency text,paid_at timestamp,paid_by text)
LANGUAGE sql STABLE AS $$
  SELECT b.tariff_id,i.currency::text,i.paid_at,c.requested_by_user_id
    FROM billing_stripe_subscriptions b
    JOIN billing_services svc ON svc.id=b.service_id AND svc.identifier='nessie'
    JOIN billing_tariffs t ON t.id=b.tariff_id AND t.service_id=b.service_id AND t.anniversary_seats
    JOIN billing_stripe_payment_invoices i ON i.id=b.initial_seat_invoice_id AND i.currency=t.currency
    JOIN billing_stripe_checkout_sessions c ON c.id=b.checkout_id
    WHERE b.org_id=p_org AND b.team_id IS NULL AND b.scope='ORGANISATION' AND b.livemode
    ORDER BY i.paid_at,b.id LIMIT 1
$$;
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION billing_first_paid_nessie_plan(text) SET search_path=pg_catalog,%I,pg_temp',current_schema());
END $$;
REVOKE ALL ON FUNCTION billing_first_paid_nessie_plan(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_first_paid_nessie_plan(text) TO uoa_admin;

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
    SELECT t.id,t.anniversary_seats,NULL::text AS selected_team INTO selected
      FROM billing_first_paid_nessie_plan(p_org) p JOIN billing_tariffs t ON t.id=p.tariff_id;
  END IF;
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

-- If the first live payment arrives before a region was chosen, bind it to
-- the checkout's buyer and currency. Existing financial records stay intact.
CREATE FUNCTION billing_lock_paid_nessie_region() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO billing_organisation_regions(org_id,region,currency,set_by_user_id,set_at,usd_per_unit)
    SELECT NEW.org_id,CASE p.currency WHEN 'USD' THEN 'US' WHEN 'EUR' THEN 'EUROPE' ELSE 'UK' END,
      p.currency,p.paid_by,p.paid_at,CASE WHEN p.currency='USD' THEN 1 END
    FROM billing_first_paid_nessie_plan(NEW.org_id) p WHERE p.currency IN ('USD','EUR','GBP')
      AND NOT EXISTS (SELECT 1 FROM billing_organisation_regions r WHERE r.org_id=NEW.org_id)
    ON CONFLICT (org_id) DO NOTHING;
  RETURN NEW;
END $$;
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION billing_lock_paid_nessie_region() SET search_path=pg_catalog,%I,pg_temp',current_schema());
END $$;
REVOKE ALL ON FUNCTION billing_lock_paid_nessie_region() FROM PUBLIC;
GRANT TRIGGER ON billing_stripe_subscriptions, billing_stripe_checkout_sessions, billing_organisation_regions TO uoa_admin;
CREATE TRIGGER billing_lock_paid_nessie_region AFTER UPDATE OF initial_seat_invoice_id ON billing_stripe_subscriptions
  FOR EACH ROW WHEN (OLD.initial_seat_invoice_id IS NULL AND NEW.initial_seat_invoice_id IS NOT NULL
    AND NEW.livemode AND NEW.team_id IS NULL) EXECUTE FUNCTION billing_lock_paid_nessie_region();

-- Backfill missing selections and repair a later selection only where no
-- currency-dependent credit, SMS or add-on business needs reconciliation.
LOCK TABLE billing_organisation_regions IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE paid_region_backfill ON COMMIT DROP AS
  SELECT org.org_id,p.* FROM (SELECT DISTINCT org_id FROM billing_stripe_subscriptions
    WHERE initial_seat_invoice_id IS NOT NULL AND livemode AND team_id IS NULL) org
    CROSS JOIN LATERAL billing_first_paid_nessie_plan(org.org_id) p WHERE p.currency IN ('USD','EUR','GBP');
INSERT INTO billing_organisation_regions(org_id,region,currency,set_by_user_id,set_at,usd_per_unit)
  SELECT org_id,CASE currency WHEN 'USD' THEN 'US' WHEN 'EUR' THEN 'EUROPE' ELSE 'UK' END,
    currency,paid_by,paid_at,CASE WHEN currency='USD' THEN 1 END FROM paid_region_backfill
  ON CONFLICT (org_id) DO NOTHING;

GRANT UPDATE(region,currency,set_by_user_id,set_at) ON billing_organisation_regions TO uoa_admin;
ALTER TABLE billing_organisation_regions DISABLE TRIGGER billing_organisation_region_set_once;
UPDATE billing_organisation_regions r
SET region=CASE p.currency WHEN 'USD' THEN 'US' WHEN 'EUR' THEN 'EUROPE' ELSE 'UK' END,
  currency=p.currency,set_by_user_id=p.paid_by,set_at=p.paid_at,usd_per_unit=CASE WHEN p.currency='USD' THEN 1 END
FROM paid_region_backfill p WHERE r.org_id=p.org_id AND r.currency<>p.currency AND r.set_at>p.paid_at
  AND NOT EXISTS (SELECT 1 FROM billing_credit_accounts a WHERE a.org_id=r.org_id AND a.balance_microcredits<>0)
  AND NOT EXISTS (SELECT 1 FROM billing_credit_payment_invoices i WHERE i.org_id=r.org_id)
  AND NOT EXISTS (SELECT 1 FROM billing_credit_accounts a JOIN billing_credit_lots l ON l.credit_account_id=a.id WHERE a.org_id=r.org_id)
  AND NOT EXISTS (SELECT 1 FROM billing_credit_accounts a JOIN billing_credit_top_up_checkouts c ON c.credit_account_id=a.id WHERE a.org_id=r.org_id)
  AND NOT EXISTS (SELECT 1 FROM billing_credit_auto_top_up_consent_revisions c WHERE c.org_id=r.org_id)
  AND NOT EXISTS (SELECT 1 FROM billing_sms_quotes q WHERE q.org_id=r.org_id)
  AND NOT EXISTS (SELECT 1 FROM billing_sms_number_resources n WHERE n.org_id=r.org_id)
  AND NOT EXISTS (SELECT 1 FROM billing_recurring_addon_checkouts c WHERE c.org_id=r.org_id)
  AND NOT EXISTS (SELECT 1 FROM billing_invoices i WHERE i.org_id=r.org_id AND upper(i.currency)<>p.currency)
  AND NOT EXISTS (SELECT 1 FROM billing_stripe_payment_invoices i WHERE i.org_id=r.org_id AND upper(i.currency)<>p.currency);
ALTER TABLE billing_organisation_regions ENABLE TRIGGER billing_organisation_region_set_once;
REVOKE UPDATE(region,currency,set_by_user_id,set_at) ON billing_organisation_regions FROM uoa_admin;
-- A customer can choose the region before checkout. Serialize both orders on
-- the organisation seat guard already acquired by billing_checkout_seat_snapshot.
CREATE FUNCTION billing_check_nessie_checkout_region() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE checkout_currency text; paid_tariff text;
BEGIN
  SELECT t.currency INTO checkout_currency FROM billing_tariffs t
    JOIN billing_services s ON s.id=t.service_id AND s.identifier='nessie'
    JOIN billing_stripe_accounts a ON a.id=NEW.account_id AND a.livemode
    WHERE t.id=NEW.tariff_id AND t.anniversary_seats;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT p.tariff_id INTO paid_tariff FROM billing_first_paid_nessie_plan(NEW.org_id) p;
  IF (paid_tariff IS NOT NULL AND paid_tariff<>NEW.tariff_id) OR
    (paid_tariff IS NULL AND EXISTS (SELECT 1 FROM billing_organisation_regions
      WHERE org_id=NEW.org_id AND currency<>checkout_currency)) THEN
    RAISE EXCEPTION 'BILLING_CONTEXT_STALE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_nessie_checkout_region AFTER INSERT ON billing_stripe_checkout_sessions
  FOR EACH ROW WHEN (NEW.scope='ORGANISATION' AND NEW.tariff_source='SERVICE_DEFAULT')
  EXECUTE FUNCTION billing_check_nessie_checkout_region();

CREATE FUNCTION billing_check_nessie_region_choice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE paid_currency text;
BEGIN
  PERFORM billing_seat_touch_org(NEW.org_id);
  SELECT p.currency INTO paid_currency FROM billing_first_paid_nessie_plan(NEW.org_id) p;
  IF FOUND THEN
    IF paid_currency<>NEW.currency THEN RAISE EXCEPTION 'BILLING_REGION_IMMUTABLE'; END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (
      SELECT 1 FROM billing_stripe_checkout_sessions c
        JOIN billing_services s ON s.id=c.service_id AND s.identifier='nessie'
        JOIN billing_tariffs t ON t.id=c.tariff_id AND t.anniversary_seats
        JOIN billing_stripe_accounts a ON a.id=c.account_id AND a.livemode
        LEFT JOIN billing_stripe_subscriptions b ON b.checkout_id=c.id
      WHERE c.org_id=NEW.org_id AND c.scope='ORGANISATION' AND t.currency<>NEW.currency
        AND (c.status IN ('creating','open') OR (c.status='complete'
          AND (b.id IS NULL OR (b.initial_seat_invoice_id IS NULL AND b.status NOT IN ('canceled','incomplete_expired')))))
    ) THEN RAISE EXCEPTION 'STRIPE_TARIFF_PINNED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_nessie_region_choice BEFORE INSERT ON billing_organisation_regions
  FOR EACH ROW EXECUTE FUNCTION billing_check_nessie_region_choice();
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION billing_check_nessie_region_choice() SET search_path=pg_catalog,%I,pg_temp',current_schema());
  EXECUTE format('ALTER FUNCTION billing_check_nessie_checkout_region() SET search_path=pg_catalog,%I,pg_temp',current_schema());
END $$;
REVOKE ALL ON FUNCTION billing_check_nessie_region_choice(),billing_check_nessie_checkout_region() FROM PUBLIC;
COMMIT;
