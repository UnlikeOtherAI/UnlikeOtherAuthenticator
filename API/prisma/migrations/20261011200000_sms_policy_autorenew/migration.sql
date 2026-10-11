SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- Accepted SMS evidence names who accepted it: an operator (the exact UOA
-- subject) or the renewal job (no subject). Every existing row is an operator
-- acceptance. Adding columns fires no row trigger, so the append-only
-- evidence triggers keep refusing every UPDATE and DELETE.
ALTER TABLE billing_sms_fx_snapshots
  ADD COLUMN accepted_by VARCHAR(20) NOT NULL DEFAULT 'operator',
  ALTER COLUMN accepted_by_user_id DROP NOT NULL,
  ADD CONSTRAINT sms_fx_acceptor_kind CHECK (
    (accepted_by = 'operator' AND accepted_by_user_id IS NOT NULL)
    OR (accepted_by = 'renewal_job' AND accepted_by_user_id IS NULL));

-- provider_price is the account-specific Pricing API price read when the
-- bounds were accepted. Existing rows keep NULL: they were accepted without a
-- recorded price, so they never renew automatically and need an operator.
ALTER TABLE billing_sms_route_policies
  ADD COLUMN accepted_by VARCHAR(20) NOT NULL DEFAULT 'operator',
  ADD COLUMN provider_price DECIMAL(38,18),
  ADD COLUMN renewal_of_id TEXT,
  ALTER COLUMN accepted_by_user_id DROP NOT NULL,
  ADD CONSTRAINT sms_route_renewal_of FOREIGN KEY (renewal_of_id)
    REFERENCES billing_sms_route_policies(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_route_provider_price CHECK (provider_price IS NULL OR provider_price >= 0),
  ADD CONSTRAINT sms_route_acceptor_kind CHECK (
    (accepted_by = 'operator' AND accepted_by_user_id IS NOT NULL AND renewal_of_id IS NULL)
    OR (accepted_by = 'renewal_job' AND accepted_by_user_id IS NULL AND renewal_of_id IS NOT NULL
      AND provider_price IS NOT NULL));

-- A renewal re-attests one exact operator acceptance: the same account, route,
-- bounds and source, at a provider price no higher than the attested one.
CREATE FUNCTION billing_sms_route_renewal_attests_operator() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.renewal_of_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM billing_sms_route_policies root
    WHERE root.id = NEW.renewal_of_id AND root.accepted_by = 'operator'
      AND root.provider_price IS NOT NULL AND NEW.provider_price <= root.provider_price
      AND root.account_sid = NEW.account_sid AND root.country = NEW.country
      AND root.direction = NEW.direction AND root.currency = NEW.currency
      AND root.additional_per_segment = NEW.additional_per_segment
      AND root.additional_per_message = NEW.additional_per_message
      AND root.source = NEW.source
  ) THEN
    RAISE EXCEPTION 'SMS route renewal must re-attest its exact operator acceptance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sms_route_renewal_attests_operator BEFORE INSERT ON billing_sms_route_policies
  FOR EACH ROW EXECUTE FUNCTION billing_sms_route_renewal_attests_operator();

CREATE TABLE billing_sms_policy_alerts (
  id TEXT NOT NULL,
  kind VARCHAR(40) NOT NULL,
  subject VARCHAR(120) NOT NULL,
  message VARCHAR(1000) NOT NULL,
  opened_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP(3),
  CONSTRAINT billing_sms_policy_alerts_pkey PRIMARY KEY (id),
  CONSTRAINT sms_policy_alert_shape CHECK (kind IN ('fx_unavailable', 'fx_outside_band',
      'fx_no_baseline', 'route_needs_operator', 'route_price_rose', 'route_price_unavailable')
    AND length(trim(subject)) > 0 AND length(trim(message)) > 0
    AND last_seen_at >= opened_at AND (resolved_at IS NULL OR resolved_at >= opened_at))
);
CREATE INDEX billing_sms_policy_alerts_resolved_at_opened_at_idx
  ON billing_sms_policy_alerts(resolved_at, opened_at);
-- Concurrent instances open each condition once; that insert is the only email trigger.
CREATE UNIQUE INDEX billing_sms_policy_alerts_one_open
  ON billing_sms_policy_alerts(kind, subject) WHERE resolved_at IS NULL;

ALTER TABLE billing_sms_policy_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_sms_policy_alerts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_sms_policy_alerts FROM PUBLIC, uoa_app;
GRANT SELECT, INSERT, UPDATE ON billing_sms_policy_alerts TO uoa_admin;
