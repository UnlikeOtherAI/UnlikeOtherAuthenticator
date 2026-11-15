ALTER TABLE billing_tariffs DROP CONSTRAINT billing_tariffs_mode_values_check;
ALTER TABLE billing_tariffs ADD CONSTRAINT billing_tariffs_mode_values_check CHECK (
  (mode = 'FREE' AND markup_bps = 0 AND (
    (monthly_amount_minor = 0 AND collection_mode = 'NONE') OR
    (usage_payment_mode = 'PAY_AS_YOU_GO' AND monthly_charge_basis = 'PER_SEAT'
      AND monthly_amount_minor > 0 AND collection_mode IN ('STRIPE', 'MANUAL'))
  )) OR (mode = 'AT_COST' AND markup_bps = 0) OR mode IN ('STANDARD', 'CUSTOM')
);

CREATE OR REPLACE FUNCTION uoa_enforce_billing_stripe_price_coherence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM billing_tariffs tariff
    JOIN billing_stripe_catalogs catalog ON catalog.id = NEW.catalog_id
      AND catalog.account_id = NEW.account_id AND catalog.service_id = tariff.service_id
      AND catalog.currency = tariff.currency
    WHERE tariff.id = NEW.tariff_id AND tariff.monthly_amount_minor = NEW.monthly_amount_minor
      AND tariff.collection_mode = 'STRIPE'
  ) THEN
    RAISE EXCEPTION 'Stripe price does not match immutable tariff or account' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
