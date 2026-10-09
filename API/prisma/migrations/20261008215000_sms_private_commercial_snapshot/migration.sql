SET lock_timeout = '5s';
SET statement_timeout = '120s';
ALTER TABLE billing_sms_quotes
  ADD COLUMN commercial_policy_version VARCHAR(80) NOT NULL,
  ADD COLUMN monthly_fee_eur DECIMAL(18,6) NOT NULL,
  ADD COLUMN message_markup_bps INTEGER NOT NULL,
  ADD CONSTRAINT billing_sms_commercial_snapshot_shape CHECK (
    commercial_policy_version <> '' AND monthly_fee_eur >= 0 AND message_markup_bps BETWEEN 0 AND 999999
  );
CREATE FUNCTION billing_sms_quote_commercial_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.commercial_policy_version, NEW.monthly_fee_eur, NEW.message_markup_bps)
     IS DISTINCT FROM ROW(OLD.commercial_policy_version, OLD.monthly_fee_eur, OLD.message_markup_bps) THEN
    RAISE EXCEPTION 'SMS accepted commercial policy is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_sms_quote_commercial_immutable
BEFORE UPDATE ON billing_sms_quotes FOR EACH ROW EXECUTE FUNCTION billing_sms_quote_commercial_immutable();
