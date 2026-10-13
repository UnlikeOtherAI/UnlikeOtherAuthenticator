SET lock_timeout = '5s';
SET statement_timeout = '120s';
CREATE OR REPLACE FUNCTION billing_stripe_monthly_currency_guard() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,pg_temp AS $$
DECLARE matching BOOLEAN;
BEGIN
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.billing_stripe_subscriptions s
   JOIN %I.billing_tariffs t ON t.id=s.tariff_id
   WHERE s.id=$1 AND s.account_id=$2 AND t.currency=$3)',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
 INTO matching USING NEW.subscription_id,NEW.account_id,NEW.currency;
 IF NOT matching THEN
  RAISE EXCEPTION 'Monthly seat invoice currency must match frozen subscription terms' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
