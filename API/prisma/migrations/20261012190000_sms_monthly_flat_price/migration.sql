SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- The flat monthly price of a mobile number, one per currency, the same in every
-- country. Append-only: the newest row per currency is current and every monthly
-- quote names the row it used. An organisation's billing region picks the currency.
CREATE TABLE billing_sms_monthly_prices (
  id TEXT NOT NULL,
  amount DECIMAL(18,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  set_by VARCHAR(20) NOT NULL,
  set_by_user_id TEXT,
  set_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT billing_sms_monthly_prices_pkey PRIMARY KEY (id),
  CONSTRAINT sms_monthly_price_shape CHECK (amount > 0 AND amount < 1000000 AND currency IN ('EUR', 'GBP', 'USD')),
  CONSTRAINT sms_monthly_price_setter CHECK ((set_by = 'operator' AND set_by_user_id IS NOT NULL)
    OR (set_by = 'seed' AND set_by_user_id IS NULL)),
  CONSTRAINT sms_monthly_price_user FOREIGN KEY (set_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX billing_sms_monthly_prices_currency_set_at_idx ON billing_sms_monthly_prices(currency, set_at);
CREATE TRIGGER sms_monthly_price_immutable BEFORE UPDATE OR DELETE ON billing_sms_monthly_prices
  FOR EACH ROW EXECUTE FUNCTION billing_sms_immutable_record();
ALTER TABLE billing_sms_monthly_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_sms_monthly_prices FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_sms_monthly_prices FROM PUBLIC, uoa_app;
GRANT SELECT, INSERT ON billing_sms_monthly_prices TO uoa_admin;
INSERT INTO billing_sms_monthly_prices (id, amount, currency, set_by) VALUES
  ('sms-monthly-price-seed-eur', 4.99, 'EUR', 'seed'),
  ('sms-monthly-price-seed-gbp', 4.49, 'GBP', 'seed'),
  ('sms-monthly-price-seed-usd', 5.49, 'USD', 'seed');

-- GBP per EUR from the same dated ECB document, so GBP prices convert exactly.
-- Earlier snapshots keep NULL; GBP pricing waits for the next accepted document.
ALTER TABLE billing_sms_fx_snapshots
  ADD COLUMN gbp_per_eur DECIMAL(38,18),
  ADD CONSTRAINT sms_fx_gbp_positive CHECK (gbp_per_eur IS NULL OR gbp_per_eur > 0);

-- A monthly quote is priced in its organisation's region currency; message quotes stay USD.
ALTER TABLE billing_sms_quotes
  ADD COLUMN monthly_price_id TEXT,
  ADD CONSTRAINT sms_quote_monthly_price FOREIGN KEY (monthly_price_id)
    REFERENCES billing_sms_monthly_prices(id) ON DELETE RESTRICT,
  DROP CONSTRAINT sms_quote_shape,
  ADD CONSTRAINT sms_quote_shape CHECK (
    provider_amount >= 0 AND final_amount >= 0 AND final_currency IN ('USD', 'EUR', 'GBP')
    AND (direction = 'monthly' OR final_currency = 'USD')
    AND country ~ '^[A-Z]{2}$'
    AND ((direction = 'monthly' AND destination IS NULL AND rate_basis = 'monthly_mobile')
      OR (direction = 'inbound' AND destination IS NULL AND rate_basis = 'inbound_mobile')
      OR (direction = 'outbound' AND destination ~ '^\+[1-9][0-9]{6,14}$'
        AND rate_basis = 'maximum_mobile_carrier')));

-- SMS number subscriptions use their own Stripe Customer per organisation and
-- currency, because Stripe allows one subscription currency per Customer.
ALTER TABLE billing_stripe_customers
  DROP CONSTRAINT billing_stripe_customers_scope_check,
  ADD CONSTRAINT billing_stripe_customers_scope_check CHECK (
    (scope = 'ORGANISATION' AND team_id IS NULL
      AND scope_key IN (org_id, org_id || ':sms:EUR', org_id || ':sms:GBP', org_id || ':sms:USD'))
    OR (scope = 'TEAM' AND team_id IS NOT NULL AND scope_key = org_id || ':' || team_id));

ALTER TABLE billing_sms_policy_alerts
  DROP CONSTRAINT sms_policy_alert_shape,
  ADD CONSTRAINT sms_policy_alert_shape CHECK (kind IN ('fx_unavailable', 'fx_outside_band',
      'fx_no_baseline', 'route_needs_operator', 'route_price_rose', 'route_price_unavailable',
      'monthly_price_below_cost')
    AND length(trim(subject)) > 0 AND length(trim(message)) > 0
    AND last_seen_at >= opened_at AND (resolved_at IS NULL OR resolved_at >= opened_at));
