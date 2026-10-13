ALTER TABLE billing_stripe_checkout_sessions DROP CONSTRAINT billing_stripe_checkout_sessions_tariff_source_check;
ALTER TABLE billing_stripe_checkout_sessions ADD CONSTRAINT billing_stripe_checkout_sessions_tariff_source_check CHECK (
  (tariff_source='SERVICE_DEFAULT' AND tariff_assignment_id IS NULL)
  OR (tariff_source IN ('ORGANISATION','TEAM') AND tariff_assignment_id IS NOT NULL)
  OR (tariff_source='ORGANISATION' AND tariff_assignment_id IS NULL AND seat_offer_id IS NOT NULL)
);
ALTER TABLE billing_stripe_subscriptions DROP CONSTRAINT billing_stripe_subscriptions_tariff_source_check;
ALTER TABLE billing_stripe_subscriptions ADD CONSTRAINT billing_stripe_subscriptions_tariff_source_check CHECK (
  (tariff_source='SERVICE_DEFAULT' AND tariff_assignment_id IS NULL)
  OR tariff_source='ORGANISATION'
  OR (tariff_source='TEAM' AND tariff_assignment_id IS NOT NULL)
);
CREATE FUNCTION guard_billing_published_company_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE checkout RECORD;
BEGIN
  IF NEW.tariff_source='ORGANISATION' AND NEW.tariff_assignment_id IS NULL THEN
    SELECT * INTO checkout FROM billing_stripe_checkout_sessions WHERE id=NEW.checkout_id;
    IF checkout.seat_offer_id IS NULL OR checkout.tariff_source IS DISTINCT FROM NEW.tariff_source
      OR checkout.tariff_assignment_id IS NOT NULL OR checkout.service_id IS DISTINCT FROM NEW.service_id
      OR checkout.org_id IS DISTINCT FROM NEW.org_id OR checkout.tariff_id IS DISTINCT FROM NEW.tariff_id
      OR checkout.account_id IS DISTINCT FROM NEW.account_id OR checkout.customer_id IS DISTINCT FROM NEW.customer_id
      OR NEW.scope<>'ORGANISATION' OR NEW.team_id IS NOT NULL OR NEW.scope_key IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'company subscription without operator assignment requires exact accepted public offer checkout';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_published_company_subscription_guard BEFORE INSERT OR UPDATE ON billing_stripe_subscriptions
  FOR EACH ROW EXECUTE FUNCTION guard_billing_published_company_subscription();
