BEGIN;
-- Append a genuine alternate source. Existing base invoice rows/hashes are not
-- rewritten, and no base subscription is manufactured for an add-on payment.
ALTER TABLE billing_stripe_payment_invoices ALTER COLUMN subscription_id DROP NOT NULL;
ALTER TABLE billing_stripe_payment_invoices ADD COLUMN addon_subscription_id text
  REFERENCES billing_recurring_addon_subscriptions(id) ON DELETE RESTRICT;
ALTER TABLE billing_stripe_payment_invoices ADD COLUMN addon_period_starts_at timestamptz(3),
  ADD COLUMN addon_period_ends_at timestamptz(3);
ALTER TABLE billing_stripe_payment_invoices ADD CONSTRAINT stripe_payment_invoice_one_subscription
  CHECK ((subscription_id IS NOT NULL) <> (addon_subscription_id IS NOT NULL));
CREATE INDEX stripe_payment_invoice_addon ON billing_stripe_payment_invoices(addon_subscription_id);

CREATE FUNCTION guard_stripe_invoice_captured_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_account text;v_org text;v_team text;v_customer text;v_live boolean;v_currency text;
BEGIN
  IF NEW.subscription_id IS NOT NULL AND NEW.addon_subscription_id IS NULL THEN
    SELECT s.account_id,s.org_id,s.team_id,c.stripe_customer_id,s.livemode
      INTO v_account,v_org,v_team,v_customer,v_live FROM billing_stripe_subscriptions s
      JOIN billing_stripe_customers c ON c.id=s.customer_id AND c.account_id=s.account_id AND c.org_id=s.org_id
        AND c.team_id IS NOT DISTINCT FROM s.team_id WHERE s.id=NEW.subscription_id;
  ELSIF NEW.addon_subscription_id IS NOT NULL AND NEW.subscription_id IS NULL THEN
    -- The entitlement can target a TEAM/USER while the actual customer/payer is
    -- ORG. Old TEAM customers remain historical TEAM sources, never adopted.
    SELECT s.account_id,s.org_id,c.team_id,c.stripe_customer_id,s.livemode,catalog.currency
      INTO v_account,v_org,v_team,v_customer,v_live,v_currency FROM billing_recurring_addon_subscriptions s
      JOIN billing_stripe_customers c ON c.id=s.customer_id AND c.account_id=s.account_id AND c.org_id=s.org_id
      JOIN billing_recurring_addon_catalogs catalog ON catalog.id=s.catalog_id AND catalog.account_id=s.account_id
      WHERE s.id=NEW.addon_subscription_id;
  ELSE RAISE EXCEPTION 'STRIPE_INVOICE_SUBSCRIPTION_SOURCE_UNPROVEN'; END IF;
  IF NEW.addon_subscription_id IS NOT NULL AND (NEW.addon_period_starts_at IS NULL OR NEW.addon_period_ends_at IS NULL OR
    NEW.addon_period_ends_at<=NEW.addon_period_starts_at) OR NEW.subscription_id IS NOT NULL AND
    (NEW.addon_period_starts_at IS NOT NULL OR NEW.addon_period_ends_at IS NOT NULL) THEN
    RAISE EXCEPTION 'STRIPE_INVOICE_SUBSCRIPTION_PERIOD_UNPROVEN'; END IF;
  IF v_account IS DISTINCT FROM NEW.account_id OR v_org IS DISTINCT FROM NEW.org_id OR
    v_team IS DISTINCT FROM NEW.team_id OR v_customer IS DISTINCT FROM NEW.stripe_customer_id OR
    v_live IS DISTINCT FROM NEW.livemode OR v_currency IS NOT NULL AND v_currency<>NEW.currency THEN
    RAISE EXCEPTION 'STRIPE_INVOICE_SUBSCRIPTION_BINDING_INVALID'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stripe_invoice_captured_subscription BEFORE INSERT ON billing_stripe_payment_invoices
  FOR EACH ROW EXECUTE FUNCTION guard_stripe_invoice_captured_subscription();
COMMIT;
