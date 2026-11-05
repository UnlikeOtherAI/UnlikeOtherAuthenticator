BEGIN;

-- A billing credential's lifetime cannot erase a person's outstanding seat payment.
-- Historical integration bindings identify the product only and grant no authority.
CREATE OR REPLACE FUNCTION billing_pending_product_seats(p_org text,p_user text,p_domain text) RETURNS TABLE(team_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM billing_app_keys k JOIN billing_services s ON s.id=k.service_id
    WHERE s.identifier='nessie' AND k.purpose='CUSTOMER_LIFECYCLE'
    AND k.actor_issuer='https://'||p_domain) THEN RETURN; END IF;
  IF (session_user='uoa_app' OR current_setting('role',true)='uoa_app') AND (
    nullif(current_setting('app.user_id',true),'') IS DISTINCT FROM p_user OR
    nullif(current_setting('app.domain',true),'') IS DISTINCT FROM p_domain OR
    (nullif(current_setting('app.org_id',true),'') IS NOT NULL AND current_setting('app.org_id',true)<>p_org)
  ) THEN RETURN QUERY SELECT NULL::text; RETURN; END IF;
  RETURN QUERY SELECT DISTINCT s.team_id FROM billing_automatic_seat_changes c
    JOIN billing_seat_subscriptions s ON s.id=c.seat_subscription_id
    JOIN billing_services svc ON svc.id=s.service_id AND svc.identifier='nessie'
    WHERE c.user_id=p_user AND c.delta=1 AND c.completed_at IS NULL AND s.org_id=p_org AND s.ended_at IS NULL;
END;
$$;

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION billing_pending_product_seats(text,text,text) SET search_path=pg_catalog,%I,pg_temp',current_schema());
END;
$$;
REVOKE ALL ON FUNCTION billing_pending_product_seats(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_pending_product_seats(text,text,text) TO uoa_app,uoa_admin;

COMMIT;

