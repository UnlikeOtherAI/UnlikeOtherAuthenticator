SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- Connected provider-service rates are part of one immutable prepaid tariff
-- version: usage of one Ledger connector is rated with its own markup and shown
-- as its own customer line. They are written with the version and never change.
CREATE TYPE "BillingProviderServiceLineKind" AS ENUM ('CLOUD_BROWSER');

CREATE TABLE billing_tariff_provider_service_rates (
  id TEXT PRIMARY KEY,
  tariff_id TEXT NOT NULL REFERENCES billing_tariffs(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  provider_service_id VARCHAR(100) NOT NULL
    CHECK (provider_service_id ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  markup_bps INTEGER NOT NULL CHECK (markup_bps BETWEEN 0 AND 100000),
  line_kind "BillingProviderServiceLineKind" NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT billing_tariff_provider_service_rates_tariff_id_provider_service_id_key
    UNIQUE (tariff_id, provider_service_id)
);

-- A rate is only meaningful on a prepaid standard/custom version; free and
-- at-cost versions keep their zero markup for every connector.
CREATE FUNCTION uoa_enforce_billing_provider_service_rate_tariff()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM billing_tariffs
    WHERE id = NEW.tariff_id
      AND usage_payment_mode = 'PREPAID'
      AND mode IN ('STANDARD', 'CUSTOM')
  ) THEN
    RAISE EXCEPTION 'provider service rates require a prepaid standard or custom tariff'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_tariff_provider_service_rates_tariff
BEFORE INSERT ON billing_tariff_provider_service_rates
FOR EACH ROW EXECUTE FUNCTION uoa_enforce_billing_provider_service_rate_tariff();

CREATE FUNCTION uoa_enforce_billing_provider_service_rate_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'billing tariff provider service rates are immutable';
END;
$$;

CREATE TRIGGER billing_tariff_provider_service_rates_immutable
BEFORE UPDATE OR DELETE ON billing_tariff_provider_service_rates
FOR EACH ROW EXECUTE FUNCTION uoa_enforce_billing_provider_service_rate_immutability();

REVOKE ALL ON TABLE billing_tariff_provider_service_rates FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE billing_tariff_provider_service_rates FROM uoa_app;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT ON TABLE billing_tariff_provider_service_rates TO uoa_admin;
  END IF;
END
$$;

ALTER TABLE billing_tariff_provider_service_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_tariff_provider_service_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_tariff_provider_service_rates_deny_app ON billing_tariff_provider_service_rates
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
