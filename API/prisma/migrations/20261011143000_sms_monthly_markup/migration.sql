SET lock_timeout = '5s';
SET statement_timeout = '120s';
-- Existing accepted quotes used a fixed EUR increment and no rental markup.
-- Preserve that historical policy; new quotes explicitly freeze their markup.
ALTER TABLE billing_sms_quotes
  ADD COLUMN monthly_markup_bps INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT billing_sms_monthly_markup_shape CHECK (monthly_markup_bps BETWEEN 0 AND 999999);
CREATE OR REPLACE FUNCTION billing_sms_quote_commercial_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.commercial_policy_version, NEW.monthly_fee_eur, NEW.message_markup_bps, NEW.monthly_markup_bps)
     IS DISTINCT FROM ROW(OLD.commercial_policy_version, OLD.monthly_fee_eur, OLD.message_markup_bps, OLD.monthly_markup_bps) THEN
    RAISE EXCEPTION 'SMS accepted commercial policy is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
