SET lock_timeout = '5s';
SET statement_timeout = '120s';
ALTER TABLE billing_stripe_monthly_charges DROP CONSTRAINT billing_stripe_monthly_charge_source_valid;
ALTER TABLE billing_stripe_monthly_charges ADD CONSTRAINT billing_stripe_monthly_charge_source_valid CHECK (
 billing_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND
 amount_minor>=0 AND currency IN('USD','EUR','GBP') AND
 authority_key ~ '^[a-f0-9]{64}$' AND source_digest ~ '^[a-f0-9]{64}$' AND
 period_starts_at<period_ends_at AND state IN('PENDING','ACCEPTED','HELD','NO_CHARGE') AND
 (state<>'ACCEPTED' OR stripe_invoice_item_id IS NOT NULL) AND
 (state<>'NO_CHARGE' OR (amount_minor=0 AND stripe_invoice_item_id IS NULL)) AND
 (amount_minor<>0 OR state='NO_CHARGE')
);
CREATE FUNCTION billing_stripe_monthly_currency_guard() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.billing_stripe_subscriptions s
   JOIN public.billing_tariffs t ON t.id=s.tariff_id
   WHERE s.id=NEW.subscription_id AND s.account_id=NEW.account_id AND t.currency=NEW.currency) THEN
  RAISE EXCEPTION 'Monthly seat invoice currency must match frozen subscription terms' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER billing_stripe_monthly_currency BEFORE INSERT ON billing_stripe_monthly_charges
 FOR EACH ROW EXECUTE FUNCTION billing_stripe_monthly_currency_guard();
