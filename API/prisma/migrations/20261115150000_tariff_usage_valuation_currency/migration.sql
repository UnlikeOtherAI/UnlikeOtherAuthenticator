SET lock_timeout = '5s';
SET statement_timeout = '120s';
ALTER TABLE billing_tariffs ADD COLUMN usage_currency CHAR(3);
-- Preserve historical accepted terms exactly; this is no FX conversion.
UPDATE billing_tariffs SET usage_currency=currency;
ALTER TABLE billing_tariffs ALTER COLUMN usage_currency SET NOT NULL,
 ALTER COLUMN usage_currency SET DEFAULT '';
CREATE FUNCTION billing_tariff_usage_currency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.usage_currency='' THEN NEW.usage_currency:=NEW.currency; END IF;
 IF TG_OP='UPDATE' AND NEW.usage_currency IS DISTINCT FROM OLD.usage_currency THEN
  RAISE EXCEPTION 'usage valuation currency is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER billing_tariff_usage_currency BEFORE INSERT OR UPDATE ON billing_tariffs
 FOR EACH ROW EXECUTE FUNCTION billing_tariff_usage_currency_guard();
ALTER TABLE billing_tariffs ADD CONSTRAINT billing_usage_currency_iso CHECK(usage_currency~'^[A-Z]{3}$'),
 ADD CONSTRAINT billing_prepaid_currency_separation CHECK(usage_currency=currency OR usage_payment_mode='PREPAID');
